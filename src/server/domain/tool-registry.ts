/**
 * 工具档案注册表(能力中心基础设施)。
 *
 * 平台级:扫描 tools/ 目录的工具档案(.md + frontmatter),索引到 tool_registry 表。
 * 工具档案不是安装清单,而是"能力 → 可用实现"的备选目录。
 * 员工执行时若已有相似能力工具则优先用自己的,否则参考推荐实现。
 * 是否安装新工具由员工自行决定,平台不做强制门禁。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DB } from '../db/client';
import { nowIso } from '../../shared/utils';

/** 工具档案 frontmatter schema。 */
export const toolManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  capability: z.string().min(1),
  implementation: z.enum(['local', 'api']),
  executor_kind: z.string().default(''),
  credential_keys: z.array(z.string()).default([]),
  install: z.string().default(''),
  check: z.string().default(''),
  maturity: z.enum(['stable', 'experimental', 'deprecated']).default('stable'),
});

export type ToolManifest = z.infer<typeof toolManifestSchema>;

export interface ToolRegistryEntry {
  id: string;
  capabilityId: string;
  implementation: 'local' | 'api';
  title: string;
  filePath: string;
  executorKind: string;
  credentialKeys: string;
  installHint: string | null;
  checkHint: string | null;
  maturity: 'stable' | 'experimental' | 'deprecated';
  isActive: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ToolRegistryRow {
  id: string;
  capability_id: string;
  implementation: string;
  title: string;
  file_path: string;
  executor_kind: string;
  credential_keys: string;
  install_hint: string | null;
  check_hint: string | null;
  maturity: string;
  is_active: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function fromRow(row: ToolRegistryRow): ToolRegistryEntry {
  return {
    id: row.id,
    capabilityId: row.capability_id,
    implementation: row.implementation as 'local' | 'api',
    title: row.title,
    filePath: row.file_path,
    executorKind: row.executor_kind,
    credentialKeys: row.credential_keys,
    installHint: row.install_hint,
    checkHint: row.check_hint,
    maturity: row.maturity as 'stable' | 'experimental' | 'deprecated',
    isActive: row.is_active === 1,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 解析单个工具档案 .md 的 frontmatter(YAML 子集:支持标量、行内数组、多行数组)。 */
export function parseToolManifest(filePath: string): ToolManifest | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = match[1];
  const data: Record<string, unknown> = {};
  let currentList: string[] | null = null;
  for (const rawLine of frontmatter.split('\n')) {
    // 多行数组项:`  - value`
    const listItemMatch = rawLine.match(/^\s+-\s+(.+)$/);
    if (listItemMatch && currentList !== null) {
      currentList.push(listItemMatch[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    currentList = null;
    const kvMatch = rawLine.match(/^([a-z_]+):\s*(.*)$/);
    if (!kvMatch) continue;
    const [, key, val] = kvMatch;
    const trimmed = val.trim();
    if (trimmed === '') {
      // 多行数组起始:下一行起是 - 项
      data[key] = [];
      currentList = data[key] as string[];
    } else if (trimmed === '[]') {
      // 空行内数组
      data[key] = [];
    } else if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      // 行内数组 [a, b]
      data[key] = trimmed.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      data[key] = trimmed.replace(/^["']|["']$/g, '');
    }
  }
  const parsed = toolManifestSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** 递归扫描 tools/ 目录所有 .md(排除 INDEX.md)。 */
export function scanToolManifests(toolsRoot: string): Array<{ manifest: ToolManifest; filePath: string }> {
  if (!existsSync(toolsRoot)) return [];
  const results: Array<{ manifest: ToolManifest; filePath: string }> = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md') && entry !== 'INDEX.md') {
        const manifest = parseToolManifest(full);
        if (manifest) {
          results.push({ manifest, filePath: path.relative(toolsRoot, full) });
        }
      }
    }
  };
  walk(toolsRoot);
  return results;
}

/** 扫描 tools/ 目录入库(幂等 upsert,保留 is_default/is_active 用户设置)。 */
export function syncToolRegistry(db: DB, toolsRoot?: string): { added: number; updated: number; removed: number } {
  const root = toolsRoot ?? path.join(process.cwd(), 'tools');
  const scanned = scanToolManifests(root);
  const scannedIds = new Set(scanned.map((s) => s.manifest.id));
  const now = nowIso();
  let added = 0;
  let updated = 0;

  for (const { manifest, filePath } of scanned) {
    const title = readToolTitle(filePath, root);
    const existing = db.prepare('SELECT id FROM tool_registry WHERE id=?').get(manifest.id) as { id: string } | undefined;
    if (existing) {
      db.prepare(`UPDATE tool_registry SET capability_id=?, implementation=?, title=?, file_path=?, executor_kind=?,
        credential_keys=?, install_hint=?, check_hint=?, maturity=?, updated_at=? WHERE id=?`)
        .run(
          manifest.capability,
          manifest.implementation,
          title,
          filePath,
          manifest.executor_kind,
          manifest.credential_keys.join(','),
          manifest.install || null,
          manifest.check || null,
          manifest.maturity,
          now,
          manifest.id,
        );
      updated++;
    } else {
      db.prepare(`INSERT INTO tool_registry
        (id, capability_id, implementation, title, file_path, executor_kind, credential_keys,
         install_hint, check_hint, maturity, is_active, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`)
        .run(
          manifest.id,
          manifest.capability,
          manifest.implementation,
          title,
          filePath,
          manifest.executor_kind,
          manifest.credential_keys.join(','),
          manifest.install || null,
          manifest.check || null,
          manifest.maturity,
          now,
          now,
        );
      added++;
    }
  }

  // 扫描已删除的档案:文件不在了,标记 inactive(不硬删,保留历史)
  const existingRows = db.prepare('SELECT id FROM tool_registry WHERE is_active=1').all() as Array<{ id: string }>;
  let removed = 0;
  for (const row of existingRows) {
    if (!scannedIds.has(row.id)) {
      db.prepare('UPDATE tool_registry SET is_active=0, updated_at=? WHERE id=?').run(now, row.id);
      removed++;
    }
  }

  return { added, updated, removed };
}

/** 从 .md 第一个 H1 提取标题,回退到文件名。 */
function readToolTitle(relativePath: string, toolsRoot: string): string {
  const content = readToolFile(relativePath, toolsRoot);
  if (content) {
    const h1 = content.match(/^#\s+(.+)$/m);
    if (h1) return h1[1].trim();
  }
  return path.basename(relativePath, '.md');
}

/** 列出工具档案。 */
export function listTools(
  db: DB,
  filter: { capabilityId?: string; implementation?: string; activeOnly?: boolean } = {},
): ToolRegistryEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.capabilityId) {
    conditions.push('capability_id=?');
    params.push(filter.capabilityId);
  }
  if (filter.implementation) {
    conditions.push('implementation=?');
    params.push(filter.implementation);
  }
  if (filter.activeOnly) {
    conditions.push('is_active=1');
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM tool_registry ${where} ORDER BY capability_id, implementation, title`)
    .all(...params) as ToolRegistryRow[];
  return rows.map(fromRow);
}

export function getTool(db: DB, id: string): ToolRegistryEntry | null {
  const row = db.prepare('SELECT * FROM tool_registry WHERE id=?').get(id) as ToolRegistryRow | undefined;
  return row ? fromRow(row) : null;
}

/** 读取工具档案全文(供前端预览和上下文注入)。 */
export function readToolContent(db: DB, id: string): string | null {
  const tool = getTool(db, id);
  if (!tool) return null;
  return readToolFile(tool.filePath);
}

/**
 * 安全读取 tools/ 下的档案文件(双重 realpath 校验,防目录穿越)。
 * 对照 readBundledSkill 的防护模式。
 */
export function readToolFile(relativePath: string, toolsRoot?: string): string | null {
  const root = path.resolve(toolsRoot ?? path.join(process.cwd(), 'tools'));
  const fullPath = path.resolve(root, relativePath);
  if (!fullPath.startsWith(`${root}${path.sep}`) || !existsSync(fullPath)) return null;
  const realRoot = realpathSync(root);
  const realPath = realpathSync(fullPath);
  if (!realPath.startsWith(`${realRoot}${path.sep}`)) return null;
  return readFileSync(realPath, 'utf8');
}

/** 后台设默认派发项。 */
export function setDefaultTools(db: DB, toolIds: string[]): void {
  const now = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE tool_registry SET is_default=0, updated_at=?').run(now);
    if (toolIds.length) {
      const placeholders = toolIds.map(() => '?').join(',');
      db.prepare(`UPDATE tool_registry SET is_default=1, updated_at=? WHERE id IN (${placeholders})`)
        .run(now, ...toolIds);
    }
  })();
}

/** 设置单个工具的默认标记。 */
export function setToolDefault(db: DB, id: string, isDefault: boolean): ToolRegistryEntry {
  const tool = getTool(db, id);
  if (!tool) throw new Error('工具档案不存在');
  db.prepare('UPDATE tool_registry SET is_default=?, updated_at=? WHERE id=?').run(isDefault ? 1 : 0, nowIso(), id);
  return getTool(db, id)!;
}

/** 设置单个工具的启停。 */
export function setToolActive(db: DB, id: string, isActive: boolean): ToolRegistryEntry {
  const tool = getTool(db, id);
  if (!tool) throw new Error('工具档案不存在');
  db.prepare('UPDATE tool_registry SET is_active=?, updated_at=? WHERE id=?').run(isActive ? 1 : 0, nowIso(), id);
  return getTool(db, id)!;
}

/** 派发默认工具到工作台。 */
export function dispatchDefaultToolsToWorkbench(db: DB): void {
  const now = nowIso();
  const defaults = db.prepare('SELECT id FROM tool_registry WHERE is_default=1 AND is_active=1').all() as Array<{ id: string }>;
  db.transaction(() => {
    for (const { id } of defaults) {
      db.prepare(`INSERT OR IGNORE INTO workbench_tool (tool_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)`)
        .run(id, now, now);
    }
  })();
}
export const dispatchDefaultToolsToCompany = (db: DB, _companyId?: string) => dispatchDefaultToolsToWorkbench(db);

/** 工作台可用工具清单。 */
export function listWorkbenchTools(db: DB): Array<ToolRegistryEntry & { enabled: boolean }> {
  const rows = db.prepare(`SELECT t.*, c.enabled AS c_enabled FROM tool_registry t
    LEFT JOIN workbench_tool c ON c.tool_id=t.id
    WHERE t.is_active=1 ORDER BY t.capability_id, t.implementation, t.title`)
    .all() as Array<ToolRegistryRow & { c_enabled: number | null }>;
  return rows.map((row) => ({
    ...fromRow(row),
    enabled: row.c_enabled === null ? row.is_default === 1 : row.c_enabled === 1,
  }));
}
export const listCompanyTools = (db: DB, _companyId?: string) => listWorkbenchTools(db);

/** 设置工作台工具启停。 */
export function setWorkbenchToolEnabled(db: DB, toolId: string, enabled: boolean): void {
  const now = nowIso();
  db.prepare(`INSERT INTO workbench_tool (tool_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tool_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`)
    .run(toolId, enabled ? 1 : 0, now, now);
}
export function setCompanyToolEnabled(db: DB, _companyId: string, toolId: string, enabled: boolean): void {
  setWorkbenchToolEnabled(db, toolId, enabled);
}
