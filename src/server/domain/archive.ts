/**
 * 蓝图组织重构 批次2：跨项目归档检索。
 *
 * 归档 = 项目记忆（memory_entry project scope）+ 项目调研摘要（settings.onboarding.research.summary）
 * + 成果元数据（artifact 路径/类型）。归档就是归档——不是新概念，是让散在三处的知识共用一套检索。
 *
 * 检索语义：
 * - 只读：检索结果只作参考注入/展示，不改变任何权限——旧项目成果不自动授权读取
 *   （跨项目读取仍需 project_reference 显式授权，B2B/引用机制不变）。
 * - 可排除当前项目（上下文注入时只给"旧档"，管理页搜索可不排除）。
 * - 中文按二元组词元命中（复用 memory.ts 的 expandMatchTokens/escapeFtsQuery）。
 */
import type { DB } from '../db/client';
import { expandMatchTokens, escapeFtsQuery } from './memory';

export type ArchiveHitKind = 'memory' | 'research' | 'artifact';

export interface ArchiveHit {
  kind: ArchiveHitKind;
  projectId: string;
  projectName: string;
  /** memory：记忆内容；research：调研摘要；artifact：成果路径（元数据，不含文件内容）。 */
  text: string;
  createdAt: string;
}

interface MemoryHitRow {
  id: string; project_id: string; content: string; updated_at: string;
}
interface ProjectRow {
  id: string; name: string; settings_json: string; updated_at: string;
}
interface ArtifactHitRow {
  project_id: string; path: string; kind: string; created_at: string;
}

function buildMatchOrs(tokens: string[]): { ors: string; values: unknown[] } {
  const ors = tokens
    .map(() => '(m.content LIKE ? OR m.id IN (SELECT entry_id FROM memory_fts WHERE memory_fts MATCH ?))')
    .join(' OR ');
  const values: unknown[] = [];
  for (const token of tokens) {
    values.push(`%${token}%`, `${escapeFtsQuery(token)}*`);
  }
  return { ors, values };
}

/** 搜项目记忆（跨项目，同公司）：project scope + active/locked + 词元命中。 */
function searchMemoryArchive(db: DB, companyId: string, excludeProjectId: string | undefined, tokens: string[]): Array<{ row: MemoryHitRow; projectName: string }> {
  if (tokens.length === 0) return [];
  const { ors, values } = buildMatchOrs(tokens);
  const sql = `SELECT m.id, m.project_id, m.content, m.updated_at, p.name AS project_name
    FROM memory_entry m
    JOIN project p ON p.id = m.project_id
    WHERE m.scope='project' AND m.state IN ('active','locked')
      AND m.can_influence=1
      ${excludeProjectId ? 'AND m.project_id != ?' : ''}
      AND (${ors})
    ORDER BY m.updated_at DESC LIMIT 20`;
  const params: unknown[] = excludeProjectId
    ? [excludeProjectId, ...values]
    : [...values];
  const rows = db.prepare(sql).all(...params) as Array<MemoryHitRow & { project_name: string }>;
  return rows.map((row) => ({ row, projectName: row.project_name }));
}

/** 搜项目调研摘要（settings.onboarding.research.summary，LIKE 词元命中）。 */
function searchResearchArchive(db: DB, companyId: string, excludeProjectId: string | undefined, tokens: string[]): Array<{ row: ProjectRow; summary: string }> {
  // Review 修复：空词元不回全量（防御：无有效词元时宁可不搜调研摘要）。
  if (tokens.length === 0) return [];
  const rows = db.prepare('SELECT id, name, settings_json, updated_at FROM project WHERE company_id=?').all(companyId) as ProjectRow[];
  const out: Array<{ row: ProjectRow; summary: string }> = [];
  for (const row of rows) {
    if (excludeProjectId && row.id === excludeProjectId) continue;
    const settings = JSON.parse(row.settings_json ?? '{}') as Record<string, unknown>;
    const onboarding = settings.onboarding as { research?: { summary?: string } } | undefined;
    const summary = (onboarding?.research?.summary ?? '').trim();
    if (!summary) continue;
    if (tokens.length > 0 && !tokens.some((token) => summary.includes(token) || row.name.includes(token))) continue;
    out.push({ row, summary });
  }
  return out.sort((a, b) => b.row.updated_at.localeCompare(a.row.updated_at));
}

/** 搜成果元数据（artifact 路径/类型 LIKE 命中；只返回元数据，不读文件内容）。 */
function searchArtifactArchive(db: DB, companyId: string, excludeProjectId: string | undefined, tokens: string[]): ArtifactHitRow[] {
  if (tokens.length === 0) return [];
  const likes = tokens.map(() => '(a.path LIKE ? OR a.kind LIKE ?)').join(' OR ');
  const values: unknown[] = [];
  for (const token of tokens) {
    values.push(`%${token}%`, `%${token}%`);
  }
  const sql = `SELECT a.project_id, a.path, a.kind, a.created_at, p.name AS project_name
    FROM artifact a
    JOIN project p ON p.id = a.project_id
    WHERE p.company_id=?
      ${excludeProjectId ? 'AND a.project_id != ?' : ''}
      AND (${likes})
    ORDER BY a.created_at DESC LIMIT 10`;
  const params: unknown[] = excludeProjectId
    ? [companyId, excludeProjectId, ...values]
    : [companyId, ...values];
  return db.prepare(sql).all(...params) as Array<ArtifactHitRow & { project_name: string }>;
}

/**
 * 跨项目归档检索：记忆 + 调研摘要 + 成果元数据，统一返回（带来源项目标注）。
 * 排序：记忆（已审批经验）→ 调研摘要 → 成果元数据；各类内按时间倒序。总量 limit 封顶。
 */
export function searchArchive(db: DB, input: {
  companyId: string;
  /** 上下文注入时排除当前项目（只给旧档）；管理页搜索可不排除。 */
  excludeProjectId?: string;
  query: string;
  limit?: number;
}): ArchiveHit[] {
  const trimmed = input.query.trim();
  if (!trimmed) return [];
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 30);
  const tokens = expandMatchTokens(trimmed).slice(0, 12);
  const hits: ArchiveHit[] = [];

  for (const { row, projectName } of searchMemoryArchive(db, input.companyId, input.excludeProjectId, tokens)) {
    hits.push({ kind: 'memory', projectId: row.project_id, projectName, text: row.content.slice(0, 240), createdAt: row.updated_at });
  }
  for (const { row, summary } of searchResearchArchive(db, input.companyId, input.excludeProjectId, tokens)) {
    hits.push({ kind: 'research', projectId: row.id, projectName: row.name, text: summary.slice(0, 240), createdAt: row.updated_at });
  }
  for (const row of searchArtifactArchive(db, input.companyId, input.excludeProjectId, tokens) as Array<ArtifactHitRow & { project_name: string }>) {
    hits.push({ kind: 'artifact', projectId: row.project_id, projectName: row.project_name, text: row.path, createdAt: row.created_at });
  }
  return hits.slice(0, limit);
}
