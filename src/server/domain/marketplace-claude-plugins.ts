/**
 * Claude Code 官方插件安装（M3 补完）。
 *
 * 来源：anthropics/claude-code 的 .claude-plugin/marketplace.json（pin commit sha，不可变）。
 * 一个 Claude Code 插件 = plugin.json（name/description/version/author）+ commands/ 与 agents/
 * 目录的 markdown 指令文件。muster 无 CLI 插件运行时，安装映射为 **skill 插件**：
 * 把 plugin 描述 + 命令/agent 正文组装为注入指令（muster 注入 = 兜底原则——
 * CLI 若自带同插件会用其原生加载，muster 副本给其它执行器兜底）。
 *
 * 去重规则与预置安装一致（同源 409 / 异源装新停旧 / 无同名直装 + 事务内二次检查）。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import type { Plugin, PluginScope } from '../../shared/plugin';
import { installPlugin } from './plugin-install';
import {
  buildPluginNameIndex,
  findExistingByName,
  disableExistingForScope,
  type PresetInstallScope,
} from './marketplace-presets';
import { log } from '../logger';

const CLAUDE_CODE_SHA = '1f6015b5d578adf79c8527443328a216d6b6a3f1';
const REGISTRY_LABEL = 'claude-code-plugins';

/** 注入型 fetch（测试用）。 */
export type ClaudeFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

interface MarketplaceFile {
  name?: string;
  description?: string;
  source?: string;
}

interface DirEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  download_url?: string | null;
}

interface PluginMeta {
  name: string;
  description: string;
  version: string;
  source: string; // 仓库内路径，如 plugins/commit-commands
}

const FETCH_LIMIT = 10; // 单个插件最多拉取的命令/agent 文件总数（跨 commands/agents 两目录合并计数）
const ASSEMBLE_DEADLINE_MS = 60_000; // 组装阶段整体截止（23 个请求串行，防单次安装悬挂数分钟）

/** 拉 marketplace.json 找插件元数据（pin sha）。找不到/拉取失败抛错。 */
async function resolvePluginMeta(name: string, f: ClaudeFetch): Promise<PluginMeta> {
  const url = `https://raw.githubusercontent.com/anthropics/claude-code/${CLAUDE_CODE_SHA}/.claude-plugin/marketplace.json`;
  const res = await f(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) {
    throw new AppError(ErrorCode.VALIDATION, `拉取 Claude Code 插件目录失败（${res.status}）——请稍后重试`);
  }
  const body = (await res.json()) as { plugins?: MarketplaceFile[] };
  const hit = (body.plugins ?? []).find((p) => p.name === name);
  if (!hit) throw new AppError(ErrorCode.NOT_FOUND, `Claude Code 官方目录中不存在插件：${name}`);
  const source = hit.source ?? `plugins/${name}`;
  return { name, description: hit.description ?? '', version: '1.0.0', source };
}

/** 列 commands/ 与 agents/ 下的 markdown 指令文件（两目录合并后统一上限 FETCH_LIMIT）。 */
async function listInstructionFiles(dirPath: string, f: ClaudeFetch): Promise<string[]> {
  // 逐段编码路径（encodeURIComponent 整路径会把 / 编成 %2F，GitHub API 兼容性不可靠）
  const encodedPath = dirPath.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const url = `https://api.github.com/repos/anthropics/claude-code/contents/${encodedPath}?ref=${CLAUDE_CODE_SHA}`;
  const res = await f(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) return [];
  const entries = (await res.json()) as DirEntry[] | { message?: string };
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e.type === 'file' && e.name.endsWith('.md'))
    .map(
      (e) =>
        e.download_url ??
        `https://raw.githubusercontent.com/anthropics/claude-code/${CLAUDE_CODE_SHA}/${encodedPath}/${encodeURIComponent(e.name)}`,
    );
}

/** 组装注入 body：plugin 描述 + 各命令/agent 正文（截断防过长），整体受截止时间约束。 */
async function assembleBody(meta: PluginMeta, f: ClaudeFetch): Promise<string> {
  const parts: string[] = [
    `# Claude Code 官方插件：${meta.name}（v${meta.version}）\n${meta.description}`,
  ];
  const files: string[] = [];
  for (const sub of ['commands', 'agents']) {
    files.push(...(await listInstructionFiles(`${meta.source}/${sub}`, f)));
  }
  const deadline = Date.now() + ASSEMBLE_DEADLINE_MS;
  for (const fileUrl of files.slice(0, FETCH_LIMIT)) {
    if (Date.now() > deadline) {
      log.warn('claude plugin assemble deadline exceeded, stopping early', { pluginName: meta.name });
      break;
    }
    try {
      const res = await f(fileUrl, { signal: AbortSignal.timeout(Math.min(12_000, deadline - Date.now())) });
      if (!res.ok) continue;
      const text = await res.text();
      parts.push(text.slice(0, 4000));
    } catch {
      /* 单个文件失败不阻塞整体安装 */
    }
  }
  return parts.join('\n\n---\n\n');
}

export interface InstallClaudePluginOptions {
  replaceExisting?: boolean;
  fetcher?: ClaudeFetch;
  enabledBy?: string;
}

/**
 * 安装一个 Claude Code 官方插件为 skill 插件。
 * 三层判定 + 事务内二次检查（与 installPreset 一致）。
 */
export async function installClaudeCodePlugin(
  db: DB,
  pluginName: string,
  scope: PresetInstallScope,
  options: InstallClaudePluginOptions = {},
): Promise<Plugin> {
  const name = pluginName.trim();
  if (!name) throw new AppError(ErrorCode.VALIDATION, '插件名不能为空');
  const f = options.fetcher ?? (globalThis.fetch as unknown as ClaudeFetch);

  // 预检查（尽早 409）
  const index = buildPluginNameIndex(db);
  const matches = findExistingByName(db, 'skill', name, index);
  const sameSource = matches.find((p) => sameClaudeSource(p.source, name));
  if (sameSource) {
    throw new AppError(ErrorCode.CONFLICT, `已安装：${name}（muster 内同名同源）`, {
      details: { existingId: sameSource.id },
    });
  }
  if (matches.length > 0 && !options.replaceExisting) {
    const hit = matches[0];
    throw new AppError(ErrorCode.CONFLICT, `muster 内已有同名条目「${hit.name}」——需先停用或选择「装新停旧」`, {
      details: { existingId: hit.id, conflict: true },
    });
  }

  const meta = await resolvePluginMeta(name, f);
  const body = await assembleBody(meta, f);

  const plugin = db.transaction(() => {
    // 二次检查（拉取窗口内可能有并发安装）
    const entityDups = db
      .prepare('SELECT id, source_kind, source_ref FROM plugin WHERE kind = ? AND lower(name) = lower(?)')
      .all('skill', name) as Array<{ id: string; source_kind: string; source_ref: string | null }>;
    for (const row of entityDups) {
      const same = row.source_kind === 'marketplace' && row.source_ref === `${REGISTRY_LABEL}@${name}`;
      if (same) {
        throw new AppError(ErrorCode.CONFLICT, `已安装：${name}（muster 内同名同源）`, {
          details: { existingId: row.id },
        });
      }
      if (!options.replaceExisting) {
        throw new AppError(ErrorCode.CONFLICT, `muster 内已有同名条目（并发安装）——请刷新后重试`, {
          details: { existingId: row.id, conflict: true },
        });
      }
    }
    if (entityDups.length > 0 && options.replaceExisting) {
      disableExistingForScope(db, entityDups.map((r) => r.id), scope, options.enabledBy);
    }
    return installPlugin(db, {
      name,
      kind: 'skill',
      source: { kind: 'marketplace', registry: REGISTRY_LABEL, ref: name },
      scope: toPluginScope(scope),
      manifest: { kind: 'skill', skill: { body, frontmatter: { description: meta.description } } },
      permissions: ['execute-command'],
      maturity: 'stable',
    });
  })();
  log.info('claude code plugin installed', { pluginName: name, scope: scope.level });
  return plugin;
}

function sameClaudeSource(source: Plugin['source'], name: string): boolean {
  return source.kind === 'marketplace' && source.registry === REGISTRY_LABEL && source.ref === name;
}

function toPluginScope(scope: PresetInstallScope): PluginScope {
  return scope.level === 'platform' ? { level: 'platform' } : { level: 'company', companyId: scope.companyId };
}
