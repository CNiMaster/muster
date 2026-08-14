/**
 * 能力商城预置策展——后端域（M1）。
 *
 * - listMarketplacePresets：返回预置目录 + 每条的「muster 已安装」/「muster 内同名冲突」状态。
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

/** (kind, 归一化 name) 命中的现有 plugin（实体行 + 只读视图）。 */
export function findExistingByName(db: DB, kind: string, name: string): Plugin[] {
  const want = normalizeName(name);
  return listPlugins(db).filter((p) => p.kind === kind && normalizeName(p.name) === want);
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

/** 判断单条预置的安装状态。 */
export function getPresetInstallStatus(db: DB, preset: MarketplacePreset): PresetWithStatus {
  const matches = findExistingByName(db, preset.kind, preset.name);
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
  const items = MARKETPLACE_PRESETS.map((p) => {
    const withState = getPresetInstallStatus(db, p);
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
 */
export async function installPreset(
  db: DB,
  presetId: string,
  scope: PresetInstallScope,
  options: InstallPresetOptions = {},
): Promise<Plugin> {
  const preset = findPreset(presetId);
  if (!preset) throw new AppError(ErrorCode.NOT_FOUND, `未知预置条目：${presetId}`);

  const matches = findExistingByName(db, preset.kind, preset.name);
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

  // 异源替换：在所选 scope 停用旧条目（muster 内唯一 winner）
  if (matches.length > 0 && options.replaceExisting) {
    disableExistingForScope(db, matches, scope, options.enabledBy);
  }

  const manifest = await buildManifest(preset, options.fetcher ?? fetchRawSkill);
  const plugin = installPlugin(db, {
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
  log.info('marketplace preset installed', { presetId, name: preset.name, scope: scope.level });
  return plugin;
}

/** 在所选 scope 停用旧同名条目（公司 scope 写 decision；平台 scope 置 status=disabled）。 */
function disableExistingForScope(
  db: DB,
  existing: Plugin[],
  scope: PresetInstallScope,
  enabledBy?: string,
): void {
  const now = nowIso();
  for (const p of existing) {
    if (scope.level === 'company') {
      // company_plugin 覆盖行对所有 plugin id 有效（含只读视图条目）
      try {
        setCompanyPluginDecision(db, scope.companyId, p.id, 'disabled', enabledBy);
      } catch {
        /* 旧条目可能已删，忽略 */
      }
    } else {
      // 平台级替换：实体行置 status=disabled；只读视图无 db 行跳过
      if (!p.id.startsWith('builtin')) {
        db.prepare('UPDATE plugin SET status = ?, updated_at = ? WHERE id = ?').run('disabled', now, p.id);
      }
    }
  }
}

function toPluginScope(scope: PresetInstallScope): PluginScope {
  return scope.level === 'platform' ? { level: 'platform' } : { level: 'company', companyId: scope.companyId };
}

/** 判断现有 plugin 来源是否与预置同源（marketplace + 同 registry 标签 + 同 preset id）。 */
function sameMarketplaceSource(source: Plugin['source'], preset: MarketplacePreset): boolean {
  if (source.kind !== 'marketplace') return false;
  return source.registry === presetRegistry(preset) && source.ref === preset.id;
}

/** 预置来源标签（不含 @，用作 marketplace source 的 registry；区分官方 skill / 官方 MCP）。 */
function presetRegistry(preset: MarketplacePreset): string {
  return preset.curatedBy === 'anthropic' ? 'anthropics-skills' : 'mcp-official';
}

function describeSource(source: Plugin['source']): string {
  if (source.kind === 'marketplace') return `商城 ${source.registry}@${source.ref.slice(0, 12)}`;
  if (source.kind === 'builtin') return '内置';
  return source.kind;
}
