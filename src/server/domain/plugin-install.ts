/**
 * Plugin 写侧（B3a + opt-out 治理）。
 *
 * 把用户/系统配置的能力（MCP server / skill / tool）落库到 plugin 表，
 * 并支持公司级启停。读侧在 plugin-adapter.ts（listPlugins）。
 *
 * 通用：kind/source/scope/manifest 都是调用方传的任意值，本模块不关心
 * 是哪个 MCP server、哪个 skill，只做 CRUD + 启停。
 *
 * 遵循「上班期间组织配置锁」：启停需 company.state === 'off'（由调用方 API 校验）。
 *
 * opt-out 语义（20260809100000 迁移后）：
 *   平台级插件（scope.level='platform'）默认对所有公司启用；
 *   公司可显式禁用（company_plugin.decision='disabled'）。
 *   公司级插件（scope.level='company'）仅对 scope.companyId 可见（公司独占绑定）。
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
import { listPlugins, parsePluginRow } from './plugin-adapter';
import { log } from '../logger';

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
 * 公司级启停（opt-out 语义）。
 *
 * decision='disabled' → 显式禁用某平台插件（写入覆盖行）
 * decision='enabled'  → 显式启用（撤销禁用：删除覆盖行，恢复默认）
 *
 * 语义：opt-out 下"启用"= 删除 decision 行（回到平台默认全开）；
 *       "禁用"= 写入 decision='disabled' 行。
 */
export function setCompanyPluginDecision(
  db: DB,
  companyId: string,
  pluginId: string,
  decision: 'enabled' | 'disabled',
  enabledBy?: string,
): void {
  // 确认 plugin 存在
  getPluginRow(db, pluginId);
  const now = nowIso();
  if (decision === 'enabled') {
    // 撤销禁用：删除覆盖行，回到平台默认全开
    db.prepare('DELETE FROM company_plugin WHERE company_id = ? AND plugin_id = ?').run(
      companyId,
      pluginId,
    );
  } else {
    // 显式禁用：upsert decision='disabled'
    db.prepare(
      `INSERT INTO company_plugin (company_id, plugin_id, enabled, decision, enabled_by, enabled_at)
       VALUES (?, ?, 0, 'disabled', ?, ?)
       ON CONFLICT(company_id, plugin_id) DO UPDATE SET enabled=0, decision='disabled', enabled_by=excluded.enabled_by, enabled_at=excluded.enabled_at`,
    ).run(companyId, pluginId, enabledBy ?? null, now);
  }
}

/**
 * 公司级启停（旧 API，opt-out 迁移后内部转调 setCompanyPluginDecision）。
 * @deprecated 改用 setCompanyPluginDecision（语义更清晰）。
 */
export function setCompanyPluginEnabled(
  db: DB,
  companyId: string,
  pluginId: string,
  enabled: boolean,
  enabledBy?: string,
): void {
  setCompanyPluginDecision(db, companyId, pluginId, enabled ? 'enabled' : 'disabled', enabledBy);
}

/**
 * 查询某公司显式禁用的平台插件 id 集合（opt-out 计算用）。
 * 这是 opt-out 模型的热路径：effective = 平台插件 MINUS 这个集合。
 */
export function listDisabledCompanyPlugins(db: DB, companyId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT plugin_id FROM company_plugin WHERE company_id = ? AND decision = 'disabled'`,
    )
    .all(companyId) as { plugin_id: string }[];
  return new Set(rows.map((r) => r.plugin_id));
}

/**
 * 查询某公司对每个 plugin 的决策状态（供 UI 渲染三态）。
 * 返回 Map<pluginId, 'enabled' | 'disabled'> —— 仅含显式决策的行。
 * 未出现在 Map 中的插件 = 'default'（平台默认）。
 */
export function getCompanyPluginDecisions(
  db: DB,
  companyId: string,
): Map<string, 'enabled' | 'disabled'> {
  const rows = db
    .prepare('SELECT plugin_id, decision FROM company_plugin WHERE company_id = ?')
    .all(companyId) as { plugin_id: string; decision: 'enabled' | 'disabled' }[];
  return new Map(rows.map((r) => [r.plugin_id, r.decision]));
}

/**
 * 计算某公司「实际生效」的插件列表（opt-out 核心）。
 *
 * 生效规则：
 *   - 平台插件（scope.level='platform'）：默认启用，减去该公司显式禁用的
 *   - 公司插件（scope.level='company', scope.companyId===companyId）：公司独占，生效；
 *     但仍可被该公司显式禁用（与历史 opt-in 语义兼容）
 *   - 其他公司独占插件：不生效
 *
 * assembleTools 调用此函数决定加载哪些 MCP server。
 */
export function getEffectivePluginsForCompany(db: DB, companyId: string): Plugin[] {
  const disabledSet = listDisabledCompanyPlugins(db, companyId);
  // 平台级插件：默认全开，减去显式禁用
  const platformPlugins = listPlugins(db, { scopeLevel: 'platform' }).filter(
    (p) => !disabledSet.has(p.id),
  );
  // 公司独占插件：仅 scope 匹配的本公司，且未被显式禁用
  const companyPlugins = listPlugins(db, { scopeLevel: 'company', scopeCompanyId: companyId }).filter(
    (p) => !disabledSet.has(p.id),
  );
  // 按 id 去重（理论上两类不会重叠，防御性）
  const byId = new Map<string, Plugin>();
  for (const p of platformPlugins) byId.set(p.id, p);
  for (const p of companyPlugins) byId.set(p.id, p);
  // 商城去重兜底（spec「同名去重与冲突解决」）：muster 内部 (kind, 归一化 name) 唯一 winner，
  // 防同名两条都生效造成上下文重复。实体行（plg_）> 只读视图（skill:/tool:/bridge:）；同秩保留先入者并告警。
  const byName = new Map<string, Plugin>();
  for (const p of byId.values()) {
    const key = `${p.kind}:${p.name.trim().toLowerCase()}`;
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, p);
    } else if (isEntityPlugin(p) && !isEntityPlugin(prev)) {
      byName.set(key, p);
    } else if (isEntityPlugin(p) === isEntityPlugin(prev)) {
      log.warn('plugin same-name duplicate kept first (defensive)', { kind: p.kind, name: p.name, kept: prev.id, dropped: p.id });
    }
  }
  return Array.from(byName.values());
}

/** 是否为 plugin 表实体行（plg_ 前缀）；否则为只读视图条目（skill:/tool:/bridge:）。 */
function isEntityPlugin(p: Plugin): boolean {
  return p.id.startsWith('plg_');
}

/**
 * 读取某公司生效的某名 skill 正文（manifest.skill.body）。
 * 注入链用：resolveTaskSkills 命中 skillId 时先查 plugin 表，再回退 bundled 目录——
 * 否则商城装的 skill 永远不进任务上下文（spec M1 必修）。
 */
export function getEffectivePluginSkillBody(db: DB, companyId: string, skillName: string): string | undefined {
  const want = skillName.trim().toLowerCase();
  const hit = getEffectivePluginsForCompany(db, companyId).find(
    (p) => p.kind === 'skill' && p.name.trim().toLowerCase() === want,
  );
  if (!hit || hit.manifest.kind !== 'skill') return undefined;
  return hit.manifest.skill.body;
}

/**
 * 查询某公司启用的 plugin id 列表（opt-out 迁移后语义=effective）。
 * 保留旧函数名供 assembleTools 等历史调用方使用，内部转 effective 计算。
 */
export function listEnabledCompanyPlugins(db: DB, companyId: string): string[] {
  return getEffectivePluginsForCompany(db, companyId).map((p) => p.id);
}

/** 标记 plugin 健康检查结果（连不上时记 health_error）。 */
export function markPluginHealth(db: DB, id: string, ok: boolean, errorMsg?: string): void {
  const now = nowIso();
  db.prepare(
    `UPDATE plugin SET health_checked_at = ?, health_error = ?, status = ?, updated_at = ? WHERE id = ?`,
  ).run(now, ok ? null : (errorMsg ?? '健康检查失败'), ok ? 'available' : 'error', now, id);
}
