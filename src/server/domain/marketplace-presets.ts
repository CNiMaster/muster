/**
 * 能力商城预置策展——后端域（M1）。
 *
 * - listMarketplacePresets：返回预置目录 + 每条的「muster 已安装」/「muster 内同名冲突」状态 + 质量信号。
 * - installPreset：三层去重判定（同源拒装 / 异源装新停旧 / 无同名直装）+ 拉取真实内容 + 落库。
 *
 * 去重范围严格限定在 muster 内部（见 spec「执行原则」）：CLI 环境同名能力不算冲突。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso } from '../../shared/utils';
import {
  MARKETPLACE_PRESETS,
  type MarketplacePreset,
} from '../../shared/marketplace-presets';
import type { Plugin, PluginManifest, PluginScope } from '../../shared/plugin';
import { installPlugin, setCompanyPluginDecision } from './plugin-install';
import { listPlugins } from './plugin-adapter';
import { getCapabilityQuality, type CapabilityQuality } from './capability-quality';
import { log } from '../logger';

/** 名称归一化（去重键用）。 */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** 按 id 找预置条目。 */
export function findPreset(id: string): MarketplacePreset | undefined {
  return MARKETPLACE_PRESETS.find((p) => p.id === id);
}

/**
 * 一次 listPlugins 构建 (kind:归一化name) → Plugin[] 索引。
 * 请求内复用（listMarketplacePresets/searchMarketplaceCatalog 的热路径只扫一遍全量插件）。
 */
export function buildPluginNameIndex(db: DB): Map<string, Plugin[]> {
  const index = new Map<string, Plugin[]>();
  for (const p of listPlugins(db)) {
    const key = `${p.kind}:${normalizeName(p.name)}`;
    const arr = index.get(key) ?? [];
    arr.push(p);
    index.set(key, arr);
  }
  return index;
}

/** (kind, 归一化 name) 命中的现有 plugin（实体行 + 只读视图）。传入预构建索引避免重复扫描。 */
export function findExistingByName(
  db: DB,
  kind: string,
  name: string,
  index?: Map<string, Plugin[]>,
): Plugin[] {
  const key = `${kind}:${normalizeName(name)}`;
  if (index) return index.get(key) ?? [];
  return (index ?? buildPluginNameIndex(db)).get(key) ?? [];
}

export type PresetInstallState = 'installable' | 'installed' | 'conflict';

export interface PresetWithStatus extends MarketplacePreset {
  /** muster 内安装状态（不涉及 CLI 环境）。 */
  installState: PresetInstallState;
  /** installed/conflict 时命中的现有条目（id/name/source）。 */
  existing?: { id: string; name: string; source: string };
  /** M4：muster 内使用质量信号（installed 且有用量记录时；成功率/次数/耗时）。 */
  quality?: CapabilityQuality;
}

/** 判断单条预置的安装状态（接受预构建索引）。 */
export function getPresetInstallStatus(
  db: DB,
  preset: MarketplacePreset,
  index?: Map<string, Plugin[]>,
): PresetWithStatus {
  const matches = findExistingByName(db, preset.kind, preset.name, index);
  if (matches.length === 0) return { ...preset, installState: 'installable' };
  const sameSource = matches.find((p) => sameMarketplaceSource(p.source, preset));
  if (sameSource) {
    return {
      ...preset,
      installState: 'installed',
      existing: { id: sameSource.id, name: sameSource.name, source: describeSource(sameSource.source) },
    };
  }
  const hit = matches[0];
  return {
    ...preset,
    installState: 'conflict',
    existing: { id: hit.id, name: hit.name, source: describeSource(hit.source) },
  };
}

/** M4 质量分：成功率主权重 + 使用量小权重（0~1）；无信号 = -1（排后，保持策展顺序）。 */
function qualityScore(q?: CapabilityQuality): number {
  if (!q || q.successRate === null) return -1;
  return q.successRate * 0.8 + Math.min(1, q.totalCalls / 10) * 0.2;
}

/** 列出全部预置 + 状态 + 质量信号；有质量信号的条目按质量分浮到前部（推荐反映真实可用性）。 */
export function listMarketplacePresets(db: DB): PresetWithStatus[] {
  const index = buildPluginNameIndex(db);
  const items = MARKETPLACE_PRESETS.map((p) => {
    const withState = getPresetInstallStatus(db, p, index);
    if (withState.installState === 'installed' && withState.existing) {
      const quality = getCapabilityQuality(db, withState.existing.id);
      if (quality.totalCalls > 0) return { ...withState, quality };
    }
    return withState;
  });
  return items
    .map((it, idx) => ({ it, idx, score: qualityScore(it.quality) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx))
    .map(({ it }) => it);
}

/** 安装范围（marketplace 仅支持 platform/company 两层）。 */
export type PresetInstallScope = { level: 'platform' } | { level: 'company'; companyId: string };

/** 远程拉取 SKILL.md 全文（raw.githubusercontent.com，pin=commit sha/tag）。 */
export async function fetchRawSkill(repo: string, path: string, pin: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repo}/${pin}/${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `拉取 ${repo}/${path}@${pin.slice(0, 12)} 失败（${res.status}）——来源可能已变更，等待目录更新`,
    );
  }
  return res.text();
}

/** 构建 manifest（raw-skill 拉正文；mcp-command 直接组装）。 */
async function buildManifest(
  preset: MarketplacePreset,
  fetcher: typeof fetchRawSkill,
): Promise<PluginManifest> {
  if (preset.install.type === 'raw-skill') {
    const body = await fetcher(preset.install.repo, preset.install.path, preset.install.pin);
    return { kind: 'skill', skill: { body } };
  }
  // mcp-command：args 里的占位符（<允许的目录> 等）原样存，用户在能力中心配置
  return {
    kind: 'mcp-server',
    mcp: { transport: 'stdio', command: preset.install.command, args: preset.install.args },
  };
}

export interface InstallPresetOptions {
  /** 异源冲突时是否「装新停旧」。false 时遇冲突抛 conflict 错误（由调用方弹窗）。 */
  replaceExisting?: boolean;
  /** 远程拉取器（测试注入）。 */
  fetcher?: typeof fetchRawSkill;
  enabledBy?: string;
}

/**
 * 安装一个预置条目为 Plugin。
 * 三层判定：同源 → 409；异源 + replaceExisting → 装新停旧；异源 + 不替换 → conflict；
 * 无同名 → 直装。
 *
 * 并发安全：网络拉取发生在事务外；落库前在事务内对实体行**二次检查**并幂等停旧，
 * 关闭「两个并发请求都通过检查后双插」的窗口（只读视图条目不落库，无此竞态）。
 */
export async function installPreset(
  db: DB,
  presetId: string,
  scope: PresetInstallScope,
  options: InstallPresetOptions = {},
): Promise<Plugin> {
  const preset = findPreset(presetId);
  if (!preset) throw new AppError(ErrorCode.NOT_FOUND, `未知预置条目：${presetId}`);

  // 预检查（尽早 409，避免无谓的网络拉取）
  const index = buildPluginNameIndex(db);
  const matches = findExistingByName(db, preset.kind, preset.name, index);
  const sameSource = matches.find((p) => sameMarketplaceSource(p.source, preset));
  if (sameSource) {
    throw new AppError(ErrorCode.CONFLICT, `已安装：${preset.name}（muster 内同名同源）`, {
      details: { existingId: sameSource.id },
    });
  }
  if (matches.length > 0 && !options.replaceExisting) {
    const hit = matches[0];
    throw new AppError(ErrorCode.CONFLICT, `muster 内已有同名条目「${hit.name}」（来源：${describeSource(hit.source)}），需先停用或选择「装新停旧」`, {
      details: { existingId: hit.id, conflict: true },
    });
  }

  const manifest = await buildManifest(preset, options.fetcher ?? fetchRawSkill);

  const plugin = db.transaction(() => {
    // 二次检查：实体行级（拉取窗口内可能有并发安装）
    const entityDups = db
      .prepare('SELECT id, source_kind, source_ref FROM plugin WHERE kind = ? AND lower(name) = lower(?)')
      .all(preset.kind, preset.name) as Array<{ id: string; source_kind: string; source_ref: string | null }>;
    for (const row of entityDups) {
      if (samePresetSourceRow(row, preset)) {
        throw new AppError(ErrorCode.CONFLICT, `已安装：${preset.name}（muster 内同名同源）`, {
          details: { existingId: row.id },
        });
      }
      if (!options.replaceExisting) {
        throw new AppError(ErrorCode.CONFLICT, `muster 内已有同名条目（并发安装）——请刷新后重试`, {
          details: { existingId: row.id, conflict: true },
        });
      }
    }
    // 异源替换：幂等停旧（重复执行安全——事务内再执行一次，覆盖并发窗口）
    if (entityDups.length > 0 && options.replaceExisting) {
      disableExistingForScope(db, entityDups.map((r) => r.id), scope, options.enabledBy);
    }
    return installPlugin(db, {
      name: preset.name,
      kind: preset.kind,
      // registry/ref 用不含 '@' 的干净标识（plugin 表 source_ref 用 `${registry}@${ref}` 编码，
      // 含 @ 的 npm 包名会破坏 parseSource 的 split('@')）。registry=来源标签，ref=preset.id。
      source: {
        kind: 'marketplace',
        registry: presetRegistry(preset),
        ref: preset.id,
      },
      scope: toPluginScope(scope),
      manifest,
      permissions: preset.permissions,
      credentialKeys: preset.install.type === 'mcp-command' ? preset.install.envKeys : undefined,
      maturity: 'stable',
    });
  })();
  log.info('marketplace preset installed', { presetId, name: preset.name, scope: scope.level });
  return plugin;
}

/** 在所选 scope 停用旧同名条目（幂等）。实体行：company 写 decision / platform 置 status；视图行：company 直写覆盖行。 */
export function disableExistingForScope(
  db: DB,
  existingIds: string[],
  scope: PresetInstallScope,
  enabledBy?: string,
): void {
  const now = nowIso();
  for (const id of existingIds) {
    if (scope.level === 'company') {
      if (isEntityId(id)) {
        try {
          setCompanyPluginDecision(db, scope.companyId, id, 'disabled', enabledBy);
        } catch {
          /* 旧条目可能已删，忽略 */
        }
      } else {
        // 只读视图条目（skill:/tool:/bridge:）：setCompanyPluginDecision 会因 getPluginRow
        // 查不到而抛错，这里直写 company_plugin 覆盖行（读路径 listDisabledCompanyPlugins 兼容视图 id）
        db.prepare(
          `INSERT INTO company_plugin (company_id, plugin_id, enabled, decision, enabled_by, enabled_at)
           VALUES (?, ?, 0, 'disabled', ?, ?)
           ON CONFLICT(company_id, plugin_id) DO UPDATE SET enabled=0, decision='disabled', enabled_by=excluded.enabled_by, enabled_at=excluded.enabled_at`,
        ).run(scope.companyId, id, enabledBy ?? null, now);
      }
    } else {
      // 平台级替换：实体行置 status=disabled（effective 已按 status 过滤，旧行即失效）；
      // 只读视图无 db 行——注入链 plugin 优先 + 去重实体>视图，新条目自然盖过，无需停用
      if (isEntityId(id)) {
        db.prepare('UPDATE plugin SET status = ?, updated_at = ? WHERE id = ?').run('disabled', now, id);
      }
    }
  }
}

export function isEntityId(id: string): boolean {
  return id.startsWith('plg_');
}

function toPluginScope(scope: PresetInstallScope): PluginScope {
  return scope.level === 'platform' ? { level: 'platform' } : { level: 'company', companyId: scope.companyId };
}

/** 判断现有 plugin 来源是否与预置同源（marketplace + 同 registry 标签 + 同 preset id）。 */
function sameMarketplaceSource(source: Plugin['source'], preset: MarketplacePreset): boolean {
  if (source.kind !== 'marketplace') return false;
  return source.registry === presetRegistry(preset) && source.ref === preset.id;
}

/** 事务内重查用的行级同源判定（source_ref 编码 = registry@ref）。 */
function samePresetSourceRow(
  row: { source_kind: string; source_ref: string | null },
  preset: MarketplacePreset,
): boolean {
  if (row.source_kind !== 'marketplace' || !row.source_ref) return false;
  return row.source_ref === `${presetRegistry(preset)}@${preset.id}`;
}

/** 预置来源标签（不含 @，用作 marketplace source 的 registry；区分官方 skill / 官方 MCP）。 */
export function presetRegistry(preset: MarketplacePreset): string {
  return preset.curatedBy === 'anthropic' ? 'anthropics-skills' : 'mcp-official';
}

function describeSource(source: Plugin['source']): string {
  if (source.kind === 'marketplace') return `商城 ${source.registry}@${source.ref.slice(0, 12)}`;
  if (source.kind === 'builtin') return '内置';
  return source.kind;
}
