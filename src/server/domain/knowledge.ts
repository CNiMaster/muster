/**
 * 知识库域（capability parity 批次 C，spec 2026-08-25-agent-host-parity-batches）。
 *
 * 定位三分（防与记忆系统混淆）：
 * - 记忆系统＝经验教训（怎么做事，自动沉淀+后台结算）
 * - 知识库＝资料正文（是什么，用户主动喂文档；本域）
 * - 素材区 material＝原始文件仓（上游，sourceMaterialId 可回链）
 *
 * 结构（拍板）：平台通用库 + 每项目一库；导入归属规则——项目上下文→项目库
 * （ensureProjectBase 幂等 get-or-create），明示通用→平台库。
 * 检索＝词法：expandMatchTokens 词元 + FTS5；标题命中加权；向量维持不排期定案。
 * FTS 应用层维护（同 memory_fts：删-插成对）。
 */
import { readFileSync } from 'node:fs';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { expandMatchTokens } from './memory';
import { escapeFtsQuery } from './memory';

export type KnowledgeScopeLevel = 'platform' | 'project';
export type KnowledgeFormat = 'md' | 'txt' | 'pdf' | 'docx' | 'html' | 'other';

export interface KnowledgeBase {
  id: string;
  scopeLevel: KnowledgeScopeLevel;
  projectId: string | null;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  docCount: number;
}

export interface KnowledgeDoc {
  id: string;
  baseId: string;
  title: string;
  format: KnowledgeFormat;
  sourceMaterialId: string | null;
  sourceUrl: string | null;
  rawPath: string | null;
  extractedText: string;
  charCount: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

type BaseRow = {
  id: string; scope_level: KnowledgeScopeLevel; project_id: string | null;
  name: string; description: string | null; created_at: string; updated_at: string;
  doc_count?: number;
};
type DocRow = {
  id: string; base_id: string; title: string; format: KnowledgeFormat;
  source_material_id: string | null; source_url: string | null; raw_path: string | null;
  extracted_text: string; char_count: number; tags_json: string;
  created_at: string; updated_at: string;
};

const MAX_DOC_TEXT_CHARS = 2_000_000; // 单文档抽取上限（约 2M 字符）
const MAX_TAGS = 8;
const SEARCH_SNIPPET_CHARS = 240;

function baseFromRow(row: BaseRow): KnowledgeBase {
  return {
    id: row.id, scopeLevel: row.scope_level, projectId: row.project_id,
    name: row.name, description: row.description,
    createdAt: row.created_at, updatedAt: row.updated_at,
    docCount: row.doc_count ?? 0,
  };
}

function docFromRow(row: DocRow): KnowledgeDoc {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags_json) as string[]; } catch { /* 容错空标签 */ }
  return {
    id: row.id, baseId: row.base_id, title: row.title, format: row.format,
    sourceMaterialId: row.source_material_id, sourceUrl: row.source_url, rawPath: row.raw_path,
    extractedText: row.extracted_text, charCount: row.char_count,
    tags: Array.isArray(tags) ? tags.slice(0, MAX_TAGS) : [],
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// ===== 库管理 =====

export function createBase(db: DB, input: {
  scopeLevel: KnowledgeScopeLevel; projectId?: string; name: string; description?: string; createdBy?: string;
}): KnowledgeBase {
  const name = input.name.trim();
  if (!name) throw new AppError(ErrorCode.VALIDATION, '知识库名称不能为空');
  if (input.scopeLevel === 'project' && !input.projectId) {
    throw new AppError(ErrorCode.VALIDATION, '项目库必须指定 projectId（或改用 ensureProjectBase）');
  }
  if (input.scopeLevel === 'platform' && input.projectId) {
    throw new AppError(ErrorCode.VALIDATION, '通用库不带 projectId');
  }
  const now = nowIso();
  const id = shortId('kb_');
  db.prepare('INSERT INTO knowledge_base (id, scope_level, project_id, name, description, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, input.scopeLevel, input.projectId ?? null, name, input.description?.trim() || null, input.createdBy ?? null, now, now);
  return baseFromRow(db.prepare('SELECT * FROM knowledge_base WHERE id=?').get(id) as BaseRow);
}

/** 项目库幂等 get-or-create（拍板：每项目一库，导入时自动确保）。 */
export function ensureProjectBase(db: DB, projectId: string, createdBy?: string): KnowledgeBase {
  const existing = db.prepare("SELECT b.*, (SELECT COUNT(*) FROM knowledge_doc d WHERE d.base_id=b.id) AS doc_count FROM knowledge_base b WHERE b.scope_level='project' AND b.project_id=?").get(projectId) as BaseRow | undefined;
  if (existing) return baseFromRow(existing);
  return createBase(db, { scopeLevel: 'project', projectId, name: '项目知识库', createdBy });
}

/** 平台通用库幂等 get-or-create。 */
export function ensurePlatformBase(db: DB, createdBy?: string): KnowledgeBase {
  const existing = db.prepare("SELECT b.*, (SELECT COUNT(*) FROM knowledge_doc d WHERE d.base_id=b.id) AS doc_count FROM knowledge_base b WHERE b.scope_level='platform'").get() as BaseRow | undefined;
  if (existing) return baseFromRow(existing);
  return createBase(db, { scopeLevel: 'platform', name: '通用知识库', createdBy });
}

export function listBases(db: DB, filter: { projectId?: string; includePlatform?: boolean } = {}): KnowledgeBase[] {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filter.projectId) {
    clauses.push("(b.scope_level='project' AND b.project_id=?)");
    values.push(filter.projectId);
    if (filter.includePlatform !== false) clauses.push("b.scope_level='platform'");
  } else {
    clauses.push("b.scope_level='platform'");
  }
  const rows = db.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM knowledge_doc d WHERE d.base_id=b.id) AS doc_count
     FROM knowledge_base b WHERE ${clauses.join(' OR ')} ORDER BY b.created_at, b.id`,
  ).all(...values) as BaseRow[];
  return rows.map(baseFromRow);
}

export function getBase(db: DB, id: string): KnowledgeBase {
  const row = db.prepare('SELECT b.*, (SELECT COUNT(*) FROM knowledge_doc d WHERE d.base_id=b.id) AS doc_count FROM knowledge_base b WHERE b.id=?').get(id) as BaseRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `知识库不存在: ${id}`);
  return baseFromRow(row);
}

export function deleteBase(db: DB, id: string): void {
  getBase(db, id);
  db.prepare('DELETE FROM knowledge_fts WHERE base_id=?').run(id);
  db.prepare('DELETE FROM knowledge_doc WHERE base_id=?').run(id);
  db.prepare('DELETE FROM knowledge_base WHERE id=?').run(id);
}

// ===== 文档导入 =====

/** 从缓冲抽取纯文本（md/txt 直存；pdf=pdf-parse；docx=mammoth；html 去标签）。 */
export async function extractText(buffer: Buffer, format: KnowledgeFormat): Promise<string> {
  let text: string;
  if (format === 'pdf') {
    // pdf-parse v2 的 ESM 类型不完整（default 缺失）——运行时双形态兼容（函数/CJS default）
    const mod = (await import('pdf-parse')) as unknown as Record<string, unknown> | ((b: Buffer) => Promise<{ text: string }>);
    const pdfParse = (typeof mod === 'function' ? mod : mod.default) as (b: Buffer) => Promise<{ text: string }>;
    text = (await pdfParse(buffer)).text ?? '';
  } else if (format === 'docx') {
    const mammoth = await import('mammoth');
    text = (await mammoth.extractRawText({ buffer })).value ?? '';
  } else if (format === 'html') {
    text = buffer.toString('utf8').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  } else {
    text = buffer.toString('utf8');
  }
  return text.slice(0, MAX_DOC_TEXT_CHARS).trim();
}

/** 按文件名推断格式。 */
export function inferFormat(filename: string): KnowledgeFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return 'other';
}

export function importDoc(db: DB, input: {
  baseId: string; title: string; format: KnowledgeFormat; text: string;
  tags?: string[]; sourceMaterialId?: string; sourceUrl?: string; rawPath?: string; createdBy?: string;
}): KnowledgeDoc {
  getBase(db, input.baseId);
  const title = input.title.trim() || '未命名文档';
  const text = input.text.slice(0, MAX_DOC_TEXT_CHARS).trim();
  if (!text) throw new AppError(ErrorCode.VALIDATION, '文档内容为空（抽取失败或空文件）');
  const tags = [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_TAGS);
  const now = nowIso();
  const id = shortId('kdoc_');
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO knowledge_doc (id, base_id, title, format, source_material_id, source_url, raw_path, extracted_text, char_count, tags_json, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.baseId, title, input.format, input.sourceMaterialId ?? null, input.sourceUrl ?? null, input.rawPath ?? null,
        text, text.length, JSON.stringify(tags), input.createdBy ?? null, now, now);
    db.prepare('INSERT INTO knowledge_fts (doc_id, base_id, title, content) VALUES (?,?,?,?)').run(id, input.baseId, title, text);
    db.prepare('UPDATE knowledge_base SET updated_at=? WHERE id=?').run(now, input.baseId);
  });
  tx();
  return docFromRow(db.prepare('SELECT * FROM knowledge_doc WHERE id=?').get(id) as DocRow);
}

/** 从文件路径导入（素材区联动：rawPath 指向素材文件，抽取后入库）。 */
export async function importFile(db: DB, input: {
  baseId: string; path: string; title?: string; tags?: string[]; sourceMaterialId?: string; createdBy?: string;
}): Promise<KnowledgeDoc> {
  const buffer = readFileSync(input.path);
  const format = inferFormat(input.path);
  const text = await extractText(buffer, format);
  return importDoc(db, {
    baseId: input.baseId,
    title: input.title ?? input.path.split('/').pop() ?? '文档',
    format, text, tags: input.tags, sourceMaterialId: input.sourceMaterialId, rawPath: input.path, createdBy: input.createdBy,
  });
}

export function listDocs(db: DB, baseId: string, opts: { limit?: number } = {}): KnowledgeDoc[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return (db.prepare('SELECT * FROM knowledge_doc WHERE base_id=? ORDER BY created_at DESC, id LIMIT ?').all(baseId, limit) as DocRow[]).map(docFromRow);
}

export function getDoc(db: DB, id: string): KnowledgeDoc {
  const row = db.prepare('SELECT * FROM knowledge_doc WHERE id=?').get(id) as DocRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `文档不存在: ${id}`);
  return docFromRow(row);
}

export function deleteDoc(db: DB, id: string): void {
  getDoc(db, id);
  db.prepare('DELETE FROM knowledge_fts WHERE doc_id=?').run(id);
  db.prepare('DELETE FROM knowledge_doc WHERE id=?').run(id);
}

// ===== 检索（词法：词元 OR + FTS5，标题/tag 命中加权）=====

export interface KnowledgeHit {
  docId: string;
  baseId: string;
  title: string;
  tags: string[];
  /** 命中片段（正文首个命中词元附近）。 */
  snippet: string;
  charCount: number;
  /** 相关性分：标题命中*3 + tag 命中*2 + FTS rank 基础分。 */
  score: number;
}

export function searchKnowledge(db: DB, input: { query: string; baseIds?: string[]; limit?: number }): KnowledgeHit[] {
  const trimmed = input.query.trim();
  if (!trimmed) return [];
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
  const tokens = expandMatchTokens(trimmed).slice(0, 12);
  if (tokens.length === 0) return [];
  // FTS 候选（bm25 自带相关性）；词元间 OR。escapeFtsQuery 已自带引号，前缀 * 外接
  const matchExpr = tokens.map((t) => `${escapeFtsQuery(t)}*`).join(' OR ');
  const sql = `SELECT knowledge_fts.doc_id, knowledge_fts.base_id, knowledge_fts.title, knowledge_fts.content,
      d.tags_json, d.char_count, bm25(knowledge_fts) AS rank
    FROM knowledge_fts JOIN knowledge_doc d ON d.id = knowledge_fts.doc_id
    WHERE knowledge_fts MATCH ? ${input.baseIds && input.baseIds.length > 0 ? `AND knowledge_fts.base_id IN (${input.baseIds.map(() => '?').join(',')})` : ''}
    ORDER BY rank LIMIT 200`;
  const values: unknown[] = [matchExpr, ...(input.baseIds ?? [])];
  const rows = db.prepare(sql).all(...values) as Array<{
    doc_id: string; base_id: string; title: string; content: string;
    tags_json: string; char_count: number; rank: number;
  }>;
  // JS 侧加权：标题/tag LIKE 命中（词面级，FTS bm25 之外的结构性优先）
  const hits: KnowledgeHit[] = rows.map((row) => {
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags_json) as string[]; } catch { /* 空 */ }
    const lowerTitle = row.title.toLowerCase();
    const joinedTags = tags.join(' ').toLowerCase();
    let score = 10 / (1 + Math.abs(row.rank));
    for (const token of tokens) {
      if (lowerTitle.includes(token.toLowerCase())) score += 3;
      if (joinedTags.includes(token.toLowerCase())) score += 2;
    }
    return {
      docId: row.doc_id, baseId: row.base_id, title: row.title, tags,
      snippet: snippetAround(row.content, tokens),
      charCount: row.char_count, score,
    };
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 取首个命中词元附近的片段。 */
function snippetAround(content: string, tokens: string[]): string {
  const lower = content.toLowerCase();
  let idx = -1;
  for (const token of tokens) {
    const found = lower.indexOf(token.toLowerCase());
    if (found >= 0) { idx = found; break; }
  }
  if (idx < 0) return content.slice(0, SEARCH_SNIPPET_CHARS);
  const start = Math.max(0, idx - 80);
  return `${start > 0 ? '…' : ''}${content.slice(start, start + SEARCH_SNIPPET_CHARS)}…`;
}
