/**
 * Marketplace 检索（B3b）。
 *
 * 抽象多个检索源，统一返回 MarketplaceEntry，让上层不关心来源差异：
 * - local：本地 skill 目录（默认 ~/.zcode/skills，可配多个根）
 * - github：用 gh search repos 检索（需 gh CLI 已登录）
 *
 * install 时把选中条目落库为 Plugin（复用 B3a installPlugin）。
 * 完全通用：不针对特定 skill，只做检索 + 安装管道。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { DB } from '../db/client';
import { installPlugin } from './plugin-install';
import { AppError, ErrorCode } from '../../shared/errors';
import type { Plugin } from '../../shared/plugin';

/** 检索来源标识。 */
export type MarketplaceSourceKind = 'local' | 'github';

/** 标准化的检索条目（跨源统一）。 */
export interface MarketplaceEntry {
  id: string; // 源内唯一 id（local 用目录名，github 用 repo full name）
  name: string;
  description: string;
  source: MarketplaceSourceKind;
  ref: string; // 安装定位用（local=目录绝对路径，github=repo full name）
  kind: 'skill' | 'mcp-server';
  maturity: 'experimental' | 'stable' | 'deprecated';
}

/** 检索本地 skill 目录（默认 ~/.zcode/skills）。返回所有 SKILL.md 条目。 */
export function searchLocalSkills(
  query: string,
  options: { roots?: string[] } = {},
): MarketplaceEntry[] {
  const roots = options.roots ?? [path.join(homedir(), '.zcode', 'skills')];
  const q = query.trim().toLowerCase();
  const results: MarketplaceEntry[] = [];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillDir = path.join(root, entry);
      let st;
      try {
        st = statSync(skillDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const skillMd = path.join(skillDir, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const parsed = parseSkillFrontmatter(readFileSync(skillMd, 'utf8'));
      const name = parsed.frontmatter.name || entry;
      const desc = parsed.frontmatter.description || '';
      // 关键词匹配（name 或 description 含 query；query 为空时全返）
      if (q && !name.toLowerCase().includes(q) && !desc.toLowerCase().includes(q)) continue;
      results.push({
        id: entry,
        name,
        description: desc,
        source: 'local',
        ref: skillDir,
        kind: 'skill',
        maturity: 'stable',
      });
    }
  }
  return results;
}

interface ParsedSkill {
  frontmatter: { name?: string; description?: string };
  body: string;
}

function parseSkillFrontmatter(content: string): ParsedSkill {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter: {}, body: content };
  const fm: { name?: string; description?: string } = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'name' || key === 'description') {
      fm[key] = val.trim().replace(/^["']|["']$/g, '');
    }
  }
  return { frontmatter: fm, body: content.slice(match[0].length) };
}

/**
 * 检索 GitHub（用 gh search repos）。
 * 需要 gh CLI 已登录。失败返回空（由调用方降级为仅 local）。
 */
export function searchGithub(query: string, options: { limit?: number } = {}): MarketplaceEntry[] {
  const q = query.trim();
  if (!q) return [];
  const limit = options.limit ?? 20;
  try {
    const cmd = `gh search repos "${q} skill OR mcp" --limit ${limit} --json fullName,description,stargazersCount`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 15_000 });
    const items = JSON.parse(output || '[]') as Array<{
      fullName: string;
      description: string | null;
      stargazersCount: number;
    }>;
    return items.map((item) => ({
      id: item.fullName,
      name: item.fullName.split('/').pop() ?? item.fullName,
      description: item.description ?? '',
      source: 'github' as const,
      ref: item.fullName,
      kind: (item.fullName.toLowerCase().includes('mcp') ? 'mcp-server' : 'skill') as 'skill' | 'mcp-server',
      maturity: item.stargazersCount > 50 ? 'stable' : 'experimental',
    }));
  } catch {
    // gh 未登录/未安装/超时 → 返回空，调用方降级
    return [];
  }
}

/** 统一检索：先 local，再 github（github 失败不致命）。 */
export function searchMarketplace(
  query: string,
  options: { localRoots?: string[]; includeGithub?: boolean } = {},
): { local: MarketplaceEntry[]; github: MarketplaceEntry[] } {
  const local = searchLocalSkills(query, { roots: options.localRoots });
  const github = options.includeGithub === false ? [] : searchGithub(query);
  return { local, github };
}

/** 安装时的 scope 形态（PluginScope 的子集，marketplace 仅支持这三层）。 */
export type InstallScope =
  | { level: 'platform' }
  | { level: 'workbench' }
  | { level: 'project'; projectId: string };

/**
 * 安装一个检索条目为 Plugin。
 * - local skill：读 SKILL.md 全文作为 manifest.skill.body，source=marketplace
 * - github：暂只记录 ref（克隆/下载留给后续，B3b 仅 local 安装完整可读）
 */
export function installMarketplaceEntry(
  db: DB,
  entry: MarketplaceEntry,
  scope: InstallScope,
  options: { id?: string } = {},
): Plugin {
  if (entry.source === 'local' && entry.kind === 'skill') {
    const body = readFileSync(path.join(entry.ref, 'SKILL.md'), 'utf8');
    return installPlugin(db, {
      id: options.id,
      name: entry.name,
      kind: 'skill',
      source: { kind: 'marketplace', registry: 'local', ref: entry.id },
      scope,
      manifest: { kind: 'skill', skill: { body } },
      maturity: entry.maturity,
    });
  }
  if (entry.source === 'github') {
    // github 条目暂只登记为 Plugin 记录（不自动克隆），maturity 默认 experimental 需人工确认
    return installPlugin(db, {
      id: options.id,
      name: entry.name,
      kind: entry.kind,
      source: { kind: 'marketplace', registry: 'github', ref: entry.ref },
      scope,
      manifest:
        entry.kind === 'mcp-server'
          ? { kind: 'mcp-server', mcp: { transport: 'stdio', command: '', args: [] } }
          : { kind: 'skill', skill: { body: '' } },
      maturity: 'experimental',
    });
  }
  throw new AppError(ErrorCode.VALIDATION, `暂不支持的 marketplace 条目类型：${entry.source}/${entry.kind}`);
}
