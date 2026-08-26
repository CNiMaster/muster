/**
 * Plugin 适配器（读侧）— B1 骨干。
 *
 * 把现存三种能力来源（Skill / Tool Registry / Bridge action）统一包装为 Plugin 只读视图，
 * 让上层（能力发现 B、项目准备 C、编排 D）只认 Plugin，不再区分三种机制。
 *
 * 设计原则：
 * - 零迁移：现有 tool_registry（0029）与 capability_binding（0027）数据不动，
 *   这里只是「读视图」，不写库。新模型写入侧（plugin 表）由 B3 批次启用。
 * - 数据库优先：plugin 表中已有的同 id 记录覆盖只读视图（便于 B3 之后逐步迁移）。
 * - 复用现有函数：tool 域完全复用 tool-registry.ts；skill 域补一个全量扫描 +
 *   frontmatter 解析（capability-binding.ts 只有任务态解析，无 listAllSkills）。
 *
 * 详见 docs/superpowers/specs/2026-07-26-capability-platform-design.md A.1 / B1 步骤 8。
 */
import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client';
import { listTools, type ToolRegistryEntry } from './tool-registry';
import { BRIDGE_ACTIONS } from '../bridge';
import type {
  Plugin,
  PluginKind,
  PluginSource,
  PluginScope,
  PluginManifest,
  PluginStatus,
  PluginMaturity,
  SkillManifest,
  ToolManifest,
  BridgeActionManifest,
  PluginRow,
} from '../../shared/plugin';

// ──────────────────────────────────────────────────────────────────────────
// Skill 数据源：全量扫描 + frontmatter 解析
// ──────────────────────────────────────────────────────────────────────────

interface BundledSkill {
  id: string;
  body: string;
  frontmatter: Record<string, string>;
}

/**
 * 解析 SKILL.md 的 frontmatter（标准 YAML 标量，只认 name/description 等单值字段）。
 * Skill 的 frontmatter 比 Tool 简单（只有标量），这里实现一个最小解析器，
 * 避免引入额外依赖；如未来 skill frontmatter 复杂化，再换 zod。
 */
function parseSkillFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter: {}, body: content };
  const fmText = match[1];
  const body = content.slice(match[0].length);
  const frontmatter: Record<string, string> = {};
  for (const line of fmText.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    frontmatter[key] = val.trim().replace(/^["']|["']$/g, '');
  }
  return { frontmatter, body };
}

/**
 * 递归扫描 skills/ 目录，返回所有 SKILL.md 解析结果。
 * 复用 capability-binding.ts readBundledSkill 的双重 realpath 目录穿越防护模式，
 * 但支持嵌套目录（skills/system/<id>/SKILL.md 等），readBundledSkill 只认一级路径。
 */
export function listBundledSkills(skillsRoot: string): BundledSkill[] {
  if (!existsSync(skillsRoot)) return [];
  const root = path.resolve(skillsRoot);
  const realRoot = realpathSync(root);
  const results: BundledSkill[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (entry === 'SKILL.md') {
        const realFull = realpathSync(full);
        if (!realFull.startsWith(`${realRoot}${path.sep}`)) continue;
        const content = readFileSync(realFull, 'utf8');
        const { frontmatter, body } = parseSkillFrontmatter(content);
        // id 取 frontmatter.name，回退父目录名
        const parentDir = path.basename(path.dirname(full));
        const id = frontmatter.name || parentDir;
        results.push({ id, body, frontmatter });
      }
    }
  };
  walk(root);
  return results;
}

// ──────────────────────────────────────────────────────────────────────────
// Bridge action 数据源：BRIDGE_ACTIONS → Plugin（kind=bridge-action）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 为单个 bridge action 生成 prompt 注入文本（per-action 版本）。
 * bridge.ts 的 buildBridgePromptSection 是批量合并文本，切片脆弱，这里按 action 单独生成。
 */
function buildSingleBridgePrompt(
  action: (typeof BRIDGE_ACTIONS)[number],
  baseUrl: string,
): string {
  const params = action.params ?? [];
  const query = params.length ? '?' + params.map((p) => `${p.name}=<value>`).join('&') : '';
  const lines: string[] = [`## ${action.name}`, action.summary, action.description, '```sh'];
  if (action.method === 'POST') {
    const bodyParams = params.filter((p) => p.name !== 'taskId');
    lines.push(
      `curl -s -X POST "${baseUrl}/bridge/${action.name}" -H "Content-Type: application/json" -d '{ ${bodyParams.map((p) => `"${p.name}": "<value>"`).join(', ')} }'`,
    );
  } else {
    lines.push(`curl -s "${baseUrl}/bridge/${action.name}${query}"`);
  }
  lines.push('```');
  if (params.length) {
    lines.push('参数：');
    for (const p of params) {
      lines.push(`- \`${p.name}\`${p.required ? '（必填）' : ''}: ${p.description}`);
    }
  }
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// 单源 → Plugin 转换
// ──────────────────────────────────────────────────────────────────────────

function skillToPlugin(skill: BundledSkill): Plugin {
  const manifest: SkillManifest = {
    body: skill.body,
    frontmatter: skill.frontmatter,
  };
  return {
    id: `skill:${skill.id}`,
    name: skill.frontmatter.name || skill.id,
    kind: 'skill',
    source: { kind: 'builtin' },
    scope: { level: 'platform' },
    manifest: { kind: 'skill', skill: manifest },
    status: 'available',
    maturity: 'stable',
  };
}

function toolToPlugin(entry: ToolRegistryEntry): Plugin {
  const manifest: ToolManifest = {
    capability: entry.capabilityId,
    implementation: entry.implementation,
    executorKind: entry.executorKind || undefined,
    install: entry.installHint ?? undefined,
    check: entry.checkHint ?? undefined,
  };
  // Tool 的 .md 全文（readToolContent）不进 Plugin，按需读取注入 prompt，
  // 与 capability-binding.ts 现有模式一致，避免 Plugin 携带大段文本。
  return {
    id: `tool:${entry.id}`,
    name: entry.title,
    kind: 'tool',
    source: { kind: 'builtin' },
    scope: { level: 'platform' },
    manifest: { kind: 'tool', tool: manifest },
    credentialKeys: entry.credentialKeys ? entry.credentialKeys.split(',').filter(Boolean) : undefined,
    status: entry.isActive ? 'available' : 'disabled',
    maturity: entry.maturity as PluginMaturity,
  };
}

function bridgeActionToPlugin(
  action: (typeof BRIDGE_ACTIONS)[number],
  baseUrl: string,
): Plugin {
  const manifest: BridgeActionManifest = {
    method: action.method ?? 'GET',
    params: action.params,
    promptSection: buildSingleBridgePrompt(action, baseUrl),
  };
  return {
    id: `bridge:${action.name}`,
    name: action.name,
    kind: 'bridge-action',
    source: { kind: 'builtin' },
    scope: { level: 'platform' },
    manifest: { kind: 'bridge-action', bridge: manifest },
    status: 'available',
    maturity: 'stable',
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 数据库 plugin 表 → Plugin（B3 写入侧启用后这里才有数据）
// ──────────────────────────────────────────────────────────────────────────

/** 把 plugin 表的行反序列化为 Plugin（plugin-install 等写侧模块复用）。 */
export function parsePluginRow(row: PluginRow): Plugin {
  const source = parseSource(row.source_kind, row.source_ref);
  const scope = parseScope(row.scope_level, row.scope_id);
  const manifest = JSON.parse(row.manifest_json) as PluginManifest;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    source,
    scope,
    manifest,
    permissions: row.permissions_json ? JSON.parse(row.permissions_json) : undefined,
    credentialKeys: row.credential_keys_json ? JSON.parse(row.credential_keys_json) : undefined,
    status: row.status,
    healthCheckedAt: row.health_checked_at ?? undefined,
    healthError: row.health_error ?? undefined,
    maturity: row.maturity,
    installedAt: row.created_at,
  };
}

function parseSource(kind: string, ref: string | null): PluginSource {
  switch (kind) {
    case 'builtin':
      return { kind: 'builtin' };
    case 'executor-native':
      return { kind: 'executor-native', provider: ref ?? '' };
    case 'workbench':
      return { kind: 'workbench' };
    case 'project':
      return { kind: 'project', projectId: ref ?? '' };
    case 'marketplace':
      return { kind: 'marketplace', registry: ref?.split('@')[0] ?? '', ref: ref?.split('@')[1] ?? '' };
    case 'ai-generated':
      return { kind: 'ai-generated', generatedAt: '', prompt: ref ?? '' };
    default:
      return { kind: 'builtin' };
  }
}

function parseScope(level: string, id: string | null): PluginScope {
  switch (level) {
    case 'platform':
      return { level: 'platform' };
    case 'workbench':
      return { level: 'workbench' };
    case 'project':
      return { level: 'project', projectId: id ?? '' };
    case 'employee':
      return { level: 'employee', agentId: id ?? '' };
    default:
      return { level: 'platform' };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 主入口：listPlugins
// ──────────────────────────────────────────────────────────────────────────

export interface ListPluginsOptions {
  /** skills/ 根目录，缺省 process.cwd()/skills。 */
  skillsRoot?: string;
  /** bridge baseUrl，用于生成 promptSection。 */
  bridgeBaseUrl?: string;
  /** 仅返回数据库 plugin 表的记录（跳过只读视图）。 */
  dbOnly?: boolean;
  /** 按 kind 过滤。 */
  kind?: PluginKind;
  /** 按 status 过滤。 */
  status?: PluginStatus;
  /** 按 scope.level 过滤（platform/workbench/project/employee）。 */
  scopeLevel?: PluginScope['level'];
}

/**
 * 列出所有 Plugin：合并「数据库 plugin 表」与「三个只读数据源（skill/tool/bridge）」。
 * 数据库记录优先（同 id 覆盖只读视图），便于 B3 之后逐步把 builtin 迁入 plugin 表。
 */
export function listPlugins(db: DB, opts: ListPluginsOptions = {}): Plugin[] {
  const byId = new Map<string, Plugin>();

  // 1. 只读视图（builtin skill/tool/bridge）
  if (!opts.dbOnly) {
    const skillsRoot = opts.skillsRoot ?? path.join(process.cwd(), 'skills');
    for (const skill of listBundledSkills(skillsRoot)) {
      const plugin = skillToPlugin(skill);
      byId.set(plugin.id, plugin);
    }
    for (const entry of listTools(db, { activeOnly: false })) {
      const plugin = toolToPlugin(entry);
      byId.set(plugin.id, plugin);
    }
    const bridgeBaseUrl = opts.bridgeBaseUrl ?? 'http://127.0.0.1:<port>';
    for (const action of BRIDGE_ACTIONS) {
      const plugin = bridgeActionToPlugin(action, bridgeBaseUrl);
      byId.set(plugin.id, plugin);
    }
  }

  // 2. 数据库 plugin 表（覆盖同 id 的只读视图）
  const rows = db.prepare('SELECT * FROM plugin').all() as PluginRow[];
  for (const row of rows) {
    byId.set(row.id, parsePluginRow(row));
  }

  let result = Array.from(byId.values());

  // 3. 过滤
  if (opts.kind) {
    result = result.filter((p) => p.kind === opts.kind);
  }
  if (opts.status) {
    result = result.filter((p) => p.status === opts.status);
  }
  if (opts.scopeLevel) {
    result = result.filter((p) => p.scope.level === opts.scopeLevel);
  }

  return result;
}

/**
 * 按 id 获取单个 Plugin。先查数据库，再查只读视图。
 */
export function getPlugin(db: DB, id: string, opts: ListPluginsOptions = {}): Plugin | null {
  const row = db.prepare('SELECT * FROM plugin WHERE id = ?').get(id) as PluginRow | undefined;
  if (row) return parsePluginRow(row);
  return listPlugins(db, opts).find((p) => p.id === id) ?? null;
}
