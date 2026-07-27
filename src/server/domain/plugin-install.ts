/**
 * Plugin 写侧（B3a）。
 *
 * 把用户/系统配置的能力（MCP server / skill / tool）落库到 plugin 表，
 * 并支持公司级启停。读侧在 plugin-adapter.ts（listPlugins）。
 *
 * 通用：kind/source/scope/manifest 都是调用方传的任意值，本模块不关心
 * 是哪个 MCP server、哪个 skill，只做 CRUD + 启停。
 *
 * 遵循「上班期间组织配置锁」：启停需 company.state === 'off'（由调用方 API 校验）。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import type {
  Plugin,
  PluginKind,
  PluginSource,
  PluginScope,
  PluginMaturity,
  PluginRow,
} from '../../shared/plugin';
import { parsePluginRow } from './plugin-adapter';

export interface InstallPluginInput {
  id?: string; // 缺省自动生成
  name: string;
  kind: PluginKind;
  source: PluginSource;
  scope: PluginScope;
  manifest: Plugin['manifest'];
  permissions?: string[];
  credentialKeys?: string[];
  maturity?: PluginMaturity;
}

function toSourceKind(s: PluginSource): string {
  return s.kind;
}

function toSourceRef(s: PluginSource): string | null {
  switch (s.kind) {
    case 'builtin':
      return null;
    case 'executor-native':
      return s.provider;
    case 'company':
      return s.companyId;
    case 'project':
      return s.projectId;
    case 'marketplace':
      return `${s.registry}@${s.ref}`;
    case 'ai-generated':
      return s.prompt;
  }
}

function toScopeLevel(s: PluginScope): string {
  return s.level;
}

function toScopeId(s: PluginScope): string | null {
  switch (s.level) {
    case 'platform':
      return null;
    case 'company':
      return s.companyId;
    case 'project':
      return s.projectId;
    case 'employee':
      return s.agentId;
  }
}

/**
 * 安装一个 Plugin（upsert：同 id 覆盖）。
 * scope_level/scope_id 从 scope 派生，manifest 序列化为 JSON。
 */
export function installPlugin(db: DB, input: InstallPluginInput): Plugin {
  const id = input.id ?? shortId('plg_');
  const now = nowIso();
  const sourceKind = toSourceKind(input.source);
  const sourceRef = toSourceRef(input.source);
  const scopeLevel = toScopeLevel(input.scope);
  const scopeId = toScopeId(input.scope);
  const manifestJson = JSON.stringify(input.manifest);
  const permissionsJson = input.permissions ? JSON.stringify(input.permissions) : null;
  const credentialKeysJson = input.credentialKeys ? JSON.stringify(input.credentialKeys) : null;
  const maturity = input.maturity ?? 'stable';

  db.prepare(
    `INSERT INTO plugin (id, name, kind, source_kind, source_ref, scope_level, scope_id, manifest_json, permissions_json, credential_keys_json, status, maturity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, kind=excluded.kind, source_kind=excluded.source_kind, source_ref=excluded.source_ref,
       scope_level=excluded.scope_level, scope_id=excluded.scope_id, manifest_json=excluded.manifest_json,
       permissions_json=excluded.permissions_json, credential_keys_json=excluded.credential_keys_json,
       maturity=excluded.maturity, updated_at=excluded.updated_at`,
  ).run(id, input.name, input.kind, sourceKind, sourceRef, scopeLevel, scopeId, manifestJson, permissionsJson, credentialKeysJson, maturity, now, now);

  return getPluginRow(db, id);
}

/** 获取单个 plugin（写侧用，直接查表）。 */
export function getPluginRow(db: DB, id: string): Plugin {
  const row = db.prepare('SELECT * FROM plugin WHERE id = ?').get(id) as PluginRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `plugin ${id} 不存在`);
  return parsePluginRow(row);
}

/** 移除 plugin（连带 company_plugin 记录，ON DELETE CASCADE）。 */
export function removePlugin(db: DB, id: string): void {
  const result = db.prepare('DELETE FROM plugin WHERE id = ?').run(id);
  if (result.changes === 0) throw new AppError(ErrorCode.NOT_FOUND, `plugin ${id} 不存在`);
}

/**
 * 公司级启停。
 * enabled=true 时在 company_plugin 置 enabled=1，false 时置 0。
 */
export function setCompanyPluginEnabled(
  db: DB,
  companyId: string,
  pluginId: string,
  enabled: boolean,
  enabledBy?: string,
): void {
  // 确认 plugin 存在
  getPluginRow(db, pluginId);
  const now = nowIso();
  db.prepare(
    `INSERT INTO company_plugin (company_id, plugin_id, enabled, enabled_by, enabled_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(company_id, plugin_id) DO UPDATE SET enabled=excluded.enabled, enabled_by=excluded.enabled_by, enabled_at=excluded.enabled_at`,
  ).run(companyId, pluginId, enabled ? 1 : 0, enabledBy ?? null, now);
}

/** 查询某公司启用的 plugin id 列表。 */
export function listEnabledCompanyPlugins(db: DB, companyId: string): string[] {
  const rows = db
    .prepare('SELECT plugin_id FROM company_plugin WHERE company_id = ? AND enabled = 1')
    .all(companyId) as { plugin_id: string }[];
  return rows.map((r) => r.plugin_id);
}

/** 标记 plugin 健康检查结果（连不上时记 health_error）。 */
export function markPluginHealth(db: DB, id: string, ok: boolean, errorMsg?: string): void {
  const now = nowIso();
  db.prepare(
    `UPDATE plugin SET health_checked_at = ?, health_error = ?, status = ?, updated_at = ? WHERE id = ?`,
  ).run(now, ok ? null : (errorMsg ?? '健康检查失败'), ok ? 'available' : 'error', now, id);
}
