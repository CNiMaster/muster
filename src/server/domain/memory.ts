import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { getAgentProfile, ensurePersonaArchiveProfile } from './agent-profile';
import { getWorkbenchOrNull } from './workbench';
import { expandTermAliases } from './matching/lexicon';
import { markCompactionDirty } from './memory-housekeeping';

export type MemoryScope = 'personal' | 'workspace' | 'project' | 'craft';
export type MemoryCandidateStatus = 'pending' | 'approved' | 'rejected';
export type MemoryEntryState = 'active' | 'locked' | 'superseded' | 'deleted';

/** 记忆正文硬上限（字符）：候选写入侧统一截断——单条超长记忆（API 手写/压缩摘要）不应独占注入配额。 */
export const MEMORY_CONTENT_MAX_CHARS = 2000;
const MEMORY_CONTENT_TRUNCATE_MARK = '…（已截断）';

/** 注入字符预算：personal 段与其余段各自限额，按既有排序截断——配额从"条数"升级为"条数+字符"双控。 */
export const MEMORY_INJECT_PERSONAL_CHAR_BUDGET = 2000;
export const MEMORY_INJECT_REST_CHAR_BUDGET = 4000;

/** personal 注入条数上限：personal 永远全量参与排序，但条数失控会挤占整个注入配额（收敛治理第一道闸）。 */
export const MEMORY_INJECT_PERSONAL_MAX_ENTRIES = 12;

/** 经验归因受控词表（spec 2026-08-22-experience-library）：模型能力/方法/上下文/工具——四路由下游各取所需。 */
export const MEMORY_CAUSES = ['model', 'method', 'context', 'tool'] as const;
export type MemoryCause = (typeof MEMORY_CAUSES)[number];

export function isMemoryCause(value: unknown): value is MemoryCause {
  return typeof value === 'string' && (MEMORY_CAUSES as readonly string[]).includes(value);
}

/** 标签归一化：小写 trim 去空，cap 5（受控词表为主自由标签为辅——防自由标签泛滥）。 */
export function normalizeMemoryTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 5);
}

export interface MemoryCandidate {
  id: string;
  profileId: string;
  scope: MemoryScope;
  projectId: string | null;
  content: string;
  sourceTaskId: string | null;
  sourceMessageId: string | null;
  author: string;
  confidence: number;
  canInfluence: boolean;
  status: MemoryCandidateStatus;
  quarantineReason: string | null;
  expiresAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  /** E2.1 结构化 category 标签（形如 "design:color"），供晋升流聚类；旧数据/null 无标签。 */
  fingerprint: string | null;
  /** 蓝图组织批次1：人设键（craft scope 的方法论归属，如 'product/product-manager'）；仅 craft scope 允许非空。 */
  personaKey: string | null;
  /** 经验归因（受控四值；null=未归因，旧数据兼容）。 */
  cause: MemoryCause | null;
  /** 自由标签（小写归一化 cap 5）。 */
  tags: string[];
  /** 记忆更新闭环：本候选替代的旧 entry id；审批通过时旧条目转 superseded、新条目继承战绩。 */
  supersedesEntryId: string | null;
}

export interface MemoryEntry {
  id: string;
  profileId: string;
  scope: MemoryScope;
  projectId: string | null;
  content: string;
  version: number;
  state: MemoryEntryState;
  canInfluence: boolean;
  sourceCandidateId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** E2.1 结构化 category 标签，供晋升流聚类。 */
  fingerprint: string | null;
  /** 蓝图组织批次1：人设键（craft scope 专属）；null = 通用技能记忆。 */
  personaKey: string | null;
  /** 记忆优势分：注入次数（记录在案的任务上下文出场）。 */
  hitCount: number;
  /** 记忆优势分：已结算的终态投票数（收缩平均的分母）。 */
  voteCount: number;
  /** 记忆优势分：优势分累计（每票 = 项目基线 − 任务消耗）。 */
  advSum: number;
  /** 经验归因（受控四值；null=未归因，旧数据兼容）。 */
  cause: MemoryCause | null;
  /** 自由标签（小写归一化 cap 5；pull 检索用，push 注入不消费）。 */
  tags: string[];
}

type CandidateRow = {
  id: string; profile_id: string; scope: MemoryScope; project_id: string | null;
  content: string; source_task_id: string | null; source_message_id: string | null; author: string;
  confidence: number; can_influence: number; status: MemoryCandidateStatus; quarantine_reason: string | null;
  expires_at: string | null; reviewed_by: string | null; reviewed_at: string | null; created_at: string;
  fingerprint: string | null; persona_key: string | null;
  cause: string | null; tags_json: string; supersedes_entry_id: string | null;
};
type EntryRow = {
  id: string; profile_id: string; scope: MemoryScope; project_id: string | null;
  content: string; version: number; state: MemoryEntryState; can_influence: number;
  source_candidate_id: string | null; expires_at: string | null; created_at: string; updated_at: string;
  fingerprint: string | null; persona_key: string | null;
  hit_count: number; vote_count: number; adv_sum: number;
  cause: string | null; tags_json: string;
};

function candidateFromRow(_db: DB, row: CandidateRow): MemoryCandidate {
  return {
    id: row.id, profileId: row.profile_id, scope: row.scope, projectId: row.project_id,
    content: row.content, sourceTaskId: row.source_task_id, sourceMessageId: row.source_message_id,
    author: row.author, confidence: row.confidence, canInfluence: row.can_influence === 1, status: row.status,
    quarantineReason: row.quarantine_reason, expiresAt: row.expires_at, reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at, createdAt: row.created_at, fingerprint: row.fingerprint,
    personaKey: row.persona_key ?? null,
    cause: isMemoryCause(row.cause) ? row.cause : null,
    tags: normalizeMemoryTags(JSON.parse(row.tags_json ?? '[]')),
    supersedesEntryId: row.supersedes_entry_id ?? null,
  };
}

function entryFromRow(_db: DB, row: EntryRow): MemoryEntry {
  return {
    id: row.id, profileId: row.profile_id, scope: row.scope, projectId: row.project_id,
    content: row.content, version: row.version, state: row.state, canInfluence: row.can_influence === 1,
    sourceCandidateId: row.source_candidate_id, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at,
    fingerprint: row.fingerprint,
    personaKey: row.persona_key ?? null,
    hitCount: row.hit_count, voteCount: row.vote_count, advSum: row.adv_sum,
    cause: isMemoryCause(row.cause) ? row.cause : null,
    tags: normalizeMemoryTags(JSON.parse(row.tags_json ?? '[]')),
  };
}

export function createMemoryCandidate(db: DB, input: {
  profileId: string; scope: MemoryScope; projectId?: string; content: string;
  sourceTaskId?: string; sourceMessageId?: string; author: string; confidence: number;
  canInfluence: boolean; expiresAt?: string; allowAutoApprove?: boolean;
  /** E2.1 结构化 category 标签（形如 "design:color"），供晋升流聚类；省略则无标签。 */
  fingerprint?: string | null;
  /** 蓝图组织批次1：人设键——craft scope 的方法论归属（如 'product/product-manager'）。仅 craft scope 允许。 */
  personaKey?: string;
  /** 经验归因（受控四值；非法值视为未归因，不阻断写入）。 */
  cause?: MemoryCause | string | null;
  /** 自由标签（归一化 cap 5）。 */
  tags?: string[];
  /** 记忆更新闭环：替代的旧 entry id。目标不合法（不存在/跨 profile/scope 不符/已终态）时静默降级为普通候选——
   * 主要生产方是反思 LLM（可能幻觉 id），不因引用错误阻断沉淀。 */
  supersedesEntryId?: string | null;
}): MemoryCandidate {
  getAgentProfile(db, input.profileId);
  validateScope(input.scope, input.projectId);
  if (input.personaKey && input.scope !== 'craft') {
    throw new AppError(ErrorCode.VALIDATION, '人设键只允许用于 craft 记忆（方法论挂在人设上）');
  }
  let content = input.content.trim();
  if (!content) throw new AppError(ErrorCode.VALIDATION, '记忆内容不能为空');
  if (input.confidence < 0 || input.confidence > 1) throw new AppError(ErrorCode.VALIDATION, '记忆可信度必须在 0 到 1 之间');
  if (content.length > MEMORY_CONTENT_MAX_CHARS) {
    // Review P2-5：截断后总长严格 ≤ cap（含截断标记），与常量声明一致。
    content = `${content.slice(0, MEMORY_CONTENT_MAX_CHARS - MEMORY_CONTENT_TRUNCATE_MARK.length)}${MEMORY_CONTENT_TRUNCATE_MARK}`;
  }
  const supersedesEntryId = validateSupersedesTarget(db, input.supersedesEntryId ?? null, input.profileId, input.scope, input.personaKey);
  const quarantineReason = scanMemoryContent(content);
  const id = shortId('mc_');
  const now = nowIso();
  const cause = isMemoryCause(input.cause) ? input.cause : null;
  const tags = normalizeMemoryTags(input.tags);
  db.prepare(
    `INSERT INTO memory_candidate (
      id, profile_id, scope, project_id, content, source_task_id, source_message_id,
      author, confidence, can_influence, status, quarantine_reason, expires_at, created_at, fingerprint, persona_key, cause, tags_json, supersedes_entry_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.profileId, input.scope, input.projectId ?? null, content,
    input.sourceTaskId ?? null, input.sourceMessageId ?? null, input.author, input.confidence,
    input.canInfluence ? 1 : 0, quarantineReason, input.expiresAt ?? null, now, input.fingerprint ?? null,
    input.personaKey ?? null, cause, JSON.stringify(tags), supersedesEntryId,
  );
  const canAutoApprove = !quarantineReason && input.allowAutoApprove === true && (
    input.scope === 'project'
    || input.author === 'user'
    // 蓝图组织批次1：人设键方法论是自包含的领域经验（不绑定公司/项目事实），高置信允许自动生效。
    || (input.scope === 'craft' && !!input.personaKey)
  );
  if (canAutoApprove) approveMemoryCandidate(db, id, input.author);
  return getMemoryCandidate(db, id);
}

export function getMemoryCandidate(db: DB, id: string): MemoryCandidate {
  const row = db.prepare('SELECT * FROM memory_candidate WHERE id=?').get(id) as CandidateRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `memory candidate ${id} not found`);
  return candidateFromRow(db, row);
}

export function listMemoryCandidates(db: DB, filter: { profileId: string; status?: MemoryCandidateStatus }): MemoryCandidate[] {
  const rows = filter.status
    ? db.prepare('SELECT * FROM memory_candidate WHERE profile_id=? AND status=? ORDER BY created_at, id').all(filter.profileId, filter.status)
    : db.prepare('SELECT * FROM memory_candidate WHERE profile_id=? ORDER BY created_at, id').all(filter.profileId);
  return (rows as CandidateRow[]).map((row) => candidateFromRow(db, row));
}

export function approveMemoryCandidate(db: DB, id: string, reviewer: string): MemoryEntry {
  const candidate = getMemoryCandidate(db, id);
  if (candidate.status !== 'pending') throw new AppError(ErrorCode.CONFLICT, '该记忆候选已经处理');
  if (candidate.quarantineReason && reviewer !== 'user') throw new AppError(ErrorCode.UNAUTHORIZED, '隔离记忆必须由用户审核');
  return db.transaction(() => {
    const now = nowIso();
    db.prepare("UPDATE memory_candidate SET status='approved', reviewed_by=?, reviewed_at=? WHERE id=?")
      .run(reviewer, now, id);
    const entryId = shortId('me_');
    db.prepare(
      `INSERT INTO memory_entry (
        id, profile_id, scope, project_id, content, version, state,
        can_influence, source_candidate_id, expires_at, created_at, updated_at, fingerprint, persona_key, cause, tags_json
      ) VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entryId, candidate.profileId, candidate.scope, candidate.projectId,
      candidate.content, candidate.canInfluence ? 1 : 0, candidate.id, candidate.expiresAt, now, now, candidate.fingerprint,
      candidate.personaKey, candidate.cause, JSON.stringify(candidate.tags),
    );
    insertMemoryVersion(db, entryId, 1, candidate.content, reviewer, candidate.id, now);
    indexMemory(db, entryId, candidate.profileId, candidate.content);
    // 记忆更新闭环：候选声明替代旧条目时，旧条目退场（superseded + 清 FTS）、新条目继承战绩。
    if (candidate.supersedesEntryId) {
      applySupersede(db, [candidate.supersedesEntryId], entryId, reviewer);
    }
    return getMemoryEntry(db, entryId);
  })();
}

/**
 * 记忆更新闭环的执行体：把 oldEntryIds 批量转为 superseded，把合计战绩（hit/vote/adv）继承给 newEntryId。
 * 只处理仍处 active/locked 的旧条目（已删除/已被替代的跳过，幂等）；craft 记忆需 persona_key 一致才可替代。
 * 个人偏好合并提案（多对一）与单条替代（一对一）共用此处。
 */
export function applySupersede(db: DB, oldEntryIds: string[], newEntryId: string, changedBy: string): number {
  const now = nowIso();
  const newEntry = db.prepare('SELECT profile_id, scope, persona_key FROM memory_entry WHERE id=?')
    .get(newEntryId) as { profile_id: string; scope: MemoryScope; persona_key: string | null } | undefined;
  if (!newEntry) throw new AppError(ErrorCode.NOT_FOUND, `memory entry ${newEntryId} not found`);
  let superseded = 0;
  db.transaction(() => {
    for (const oldId of oldEntryIds) {
      const old = db.prepare('SELECT * FROM memory_entry WHERE id=?').get(oldId) as EntryRow | undefined;
      if (!old) continue;
      if (old.state !== 'active' && old.state !== 'locked') continue;
      // craft 记忆按 persona_key 全局召回（方法论属于人设不属于执行者），替代只校验人设一致；
      // 其余 scope 仍要求同 profile（防跨员工误替代）。
      if (old.scope !== 'craft' && old.profile_id !== newEntry.profile_id) continue;
      if (old.scope !== newEntry.scope) continue;
      if (old.scope === 'craft' && (old.persona_key ?? null) !== newEntry.persona_key) continue;
      db.prepare("UPDATE memory_entry SET state='superseded', updated_at=? WHERE id=?").run(now, oldId);
      db.prepare('DELETE FROM memory_fts WHERE entry_id=?').run(oldId);
      insertMemoryVersion(db, oldId, old.version + 1, old.content, `${changedBy}:superseded-by:${newEntryId}`, null, now);
      db.prepare(
        'UPDATE memory_entry SET hit_count = hit_count + ?, vote_count = vote_count + ?, adv_sum = adv_sum + ? WHERE id=?',
      ).run(old.hit_count, old.vote_count, old.adv_sum, newEntryId);
      superseded++;
    }
  })();
  return superseded;
}

/** 替代目标合法性校验：同 scope（craft 需 persona_key 一致、放宽 profile 归属——人设方法论全局召回）、
 * 仍处 active/locked。不合法返回 null（降级为普通候选）。 */
function validateSupersedesTarget(
  db: DB, targetId: string | null, profileId: string, scope: MemoryScope, personaKey?: string,
): string | null {
  if (!targetId) return null;
  const row = db.prepare('SELECT profile_id, scope, persona_key, state FROM memory_entry WHERE id=?')
    .get(targetId) as { profile_id: string; scope: MemoryScope; persona_key: string | null; state: MemoryEntryState } | undefined;
  if (!row) return null;
  if (row.scope !== scope) return null;
  if (row.state !== 'active' && row.state !== 'locked') return null;
  if (scope === 'craft') {
    if ((row.persona_key ?? null) !== (personaKey ?? null)) return null;
  } else if (row.profile_id !== profileId) {
    return null;
  }
  return targetId;
}

export function rejectMemoryCandidate(db: DB, id: string, reviewer: string): MemoryCandidate {
  const candidate = getMemoryCandidate(db, id);
  if (candidate.status !== 'pending') throw new AppError(ErrorCode.CONFLICT, '该记忆候选已经处理');
  db.prepare("UPDATE memory_candidate SET status='rejected', reviewed_by=?, reviewed_at=? WHERE id=?")
    .run(reviewer, nowIso(), id);
  return getMemoryCandidate(db, id);
}

export function getMemoryEntry(db: DB, id: string): MemoryEntry {
  const row = db.prepare('SELECT * FROM memory_entry WHERE id=?').get(id) as EntryRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `memory entry ${id} not found`);
  return entryFromRow(db, row);
}

export function listMemoryEntries(db: DB, filter: {
  profileId?: string; scope?: MemoryScope; projectId?: string; includeDeleted?: boolean;
}): MemoryEntry[] {
  // profileId 缺省=记忆看板全局视角（capability parity 批次 D2：跨档案 4 维筛选）
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filter.profileId) { clauses.push('profile_id=?'); values.push(filter.profileId); }
  if (filter.scope) { clauses.push('scope=?'); values.push(filter.scope); }
  if (filter.projectId) { clauses.push('project_id=?'); values.push(filter.projectId); }
  if (!filter.includeDeleted) clauses.push("state!='deleted'");
  return (db.prepare(`SELECT * FROM memory_entry WHERE ${clauses.join(' AND ') || '1=1'} ORDER BY updated_at DESC, id LIMIT 500`).all(...values) as EntryRow[])
    .map((row) => entryFromRow(db, row));
}

export function correctMemoryEntry(db: DB, id: string, content: string, changedBy: string): MemoryEntry {
  const current = getMemoryEntry(db, id);
  if (current.state === 'locked') throw new AppError(ErrorCode.CONFLICT, '该记忆已锁定，请先解锁');
  if (current.state === 'deleted') throw new AppError(ErrorCode.CONFLICT, '已删除的记忆不能修改');
  const nextContent = content.trim();
  if (!nextContent) throw new AppError(ErrorCode.VALIDATION, '记忆内容不能为空');
  const nextVersion = current.version + 1;
  const now = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE memory_entry SET content=?, version=?, state=\'active\', updated_at=? WHERE id=?')
      .run(nextContent, nextVersion, now, id);
    insertMemoryVersion(db, id, nextVersion, nextContent, changedBy, null, now);
    indexMemory(db, id, current.profileId, nextContent);
  })();
  return getMemoryEntry(db, id);
}

export function lockMemoryEntry(db: DB, id: string): MemoryEntry {
  const current = getMemoryEntry(db, id);
  if (current.state === 'deleted') throw new AppError(ErrorCode.CONFLICT, '已删除的记忆不能锁定');
  db.prepare("UPDATE memory_entry SET state='locked', updated_at=? WHERE id=?").run(nowIso(), id);
  return getMemoryEntry(db, id);
}

export function unlockMemoryEntry(db: DB, id: string): MemoryEntry {
  const current = getMemoryEntry(db, id);
  if (current.state !== 'locked') throw new AppError(ErrorCode.CONFLICT, '该记忆未锁定');
  db.prepare("UPDATE memory_entry SET state='active', updated_at=? WHERE id=?").run(nowIso(), id);
  return getMemoryEntry(db, id);
}

export function deleteMemoryEntry(db: DB, id: string, changedBy: string): MemoryEntry {
  const current = getMemoryEntry(db, id);
  if (current.state === 'locked') throw new AppError(ErrorCode.CONFLICT, '该记忆已锁定，请先解锁');
  const now = nowIso();
  db.prepare("UPDATE memory_entry SET state='deleted', updated_at=? WHERE id=?").run(now, id);
  db.prepare('DELETE FROM memory_fts WHERE entry_id=?').run(id);
  insertMemoryVersion(db, id, current.version + 1, current.content, `${changedBy}:delete`, null, now);
  return getMemoryEntry(db, id);
}

/**
 * 把一次性执行体（蜂群工蜂等）profile 名下的人设方法论记忆改挂到「人设方法论档案」宿主。
 * 必须在删除该 profile 前调用——memory_entry.profile_id 是 ON DELETE CASCADE，
 * 不迁移的话专家蜂沉淀的 CRAFT 会随 profile 物理删除。
 * 只迁移 craft+persona_key 行（含候选）；personal/project 记忆与临时执行体绑定，随删。
 */
export function preservePersonaCraftMemories(db: DB, fromProfileId: string): number {
  const to = ensurePersonaArchiveProfile(db);
  const entries = db
    .prepare(`UPDATE memory_entry SET profile_id=? WHERE profile_id=? AND scope='craft' AND persona_key IS NOT NULL`)
    .run(to, fromProfileId).changes;
  const candidates = db
    .prepare(`UPDATE memory_candidate SET profile_id=? WHERE profile_id=? AND scope='craft' AND persona_key IS NOT NULL`)
    .run(to, fromProfileId).changes;
  return entries + candidates;
}

export function searchMemory(db: DB, input: {
  profileId: string; query: string; projectId?: string; limit?: number;
  /** 经验库 pull：按标签过滤（小写归一化精确匹配 tags_json 元素）。 */
  tag?: string;
  /** 经验库 pull：按归因过滤（受控四值）。 */
  cause?: MemoryCause;
}): MemoryEntry[] {  const query = input.query.trim();
  if (!query) return [];
  const now = nowIso();
  // 经验库 pull 过滤（spec 2026-08-22）：tag/cause 只作用于检索，注入路径（loadContextMemories）不消费。
  const causeFilter = isMemoryCause(input.cause) ? input.cause : null;
  // 标签值进 LIKE 模式：白名单字符（防 %/_ 通配与引号注入）；归一化后为空则不过滤
  const tagFilter = (input.tag ?? '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]/g, '');
  const rows = db.prepare(
    `SELECT DISTINCT m.* FROM memory_entry m
     WHERE m.state IN ('active','locked')
       AND (m.expires_at IS NULL OR m.expires_at > ?)
       AND (
         -- 修复轮（批次 F 定案 #8）：personal 是用户偏好，属于用户不属于员工——检索全局可见，不按 profile 过滤
         (m.scope='personal')
         OR (m.scope='craft' AND m.profile_id=?)
         OR (m.scope='workspace' AND m.profile_id=?)
         OR (m.scope='project' AND m.profile_id=? AND m.project_id=?)
       )
       AND (m.content LIKE ? OR m.id IN (SELECT entry_id FROM memory_fts WHERE memory_fts MATCH ?))
       AND (? IS NULL OR m.cause = ?)
       AND (? = '' OR m.tags_json LIKE ?)
     ORDER BY m.updated_at DESC LIMIT ?`,
  ).all(
    now, input.profileId, input.profileId, input.profileId, input.projectId ?? null,
    `%${query}%`, `${escapeFtsQuery(query)}*`,
    causeFilter, causeFilter,
    tagFilter, `%"${tagFilter}"%`,
    Math.min(Math.max(input.limit ?? 8, 1), 50),
  ) as EntryRow[];
  return rows.map((row) => entryFromRow(db, row));
}

/**
 * 将查询拆成匹配词元：按空白分词；中文连续段保留整段并生成重叠二元组（bigram），
 * 英文/数字词保持整词。中文无空格，整句 LIKE/FTS 前缀无法命中语义相关的记忆
 * （如任务"实现事件模块" vs 记忆"决定采用事件驱动架构"），二元组可跨句命中子串。
 * 蓝图组织批次2：导出供归档检索（archive.ts）复用同一套词元逻辑。
 */
export function expandMatchTokens(query: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => { if (t && !seen.has(t)) { seen.add(t); tokens.push(t); } };
  for (const segment of query.split(/\s+/)) {
    if (!segment) continue;
    // 按 CJK / 非 CJK 连续段切分（如 '前端React' → ['前端', 'React']）
    for (const run of segment.match(/[\u4e00-\u9fff]+|[^\u4e00-\u9fff]+/g) ?? [segment]) {
      if (/[\u4e00-\u9fff]/.test(run)) {
        push(run); // 整段（含单字查询）
        for (let i = 0; i + 2 <= run.length; i += 1) push(run.slice(i, i + 2)); // 重叠二元组
      } else {
        push(run);
      }
    }
  }
  // 词法增强（拍板：只词法不向量）：整词 token 追加同义别名——'测试' 任务也能命中写 'test' 的记忆。
  // 双向互补：FTS/LIKE 的 OR 集同时含两种写法。cap 40 防长查询的 bigram+别名膨胀拖垮 SQL。
  const withAliases = new Set<string>();
  for (const token of tokens) {
    for (const alias of expandTermAliases(token)) withAliases.add(alias);
    if (withAliases.size >= 40) break;
  }
  return [...withAliases];
}

// ===== 记忆优势分（注入战绩）=====
/** 返工一轮折算的消耗权重（重：一次返工 ≈ 两轮追问的折腾）。 */
const REWORK_WEIGHT = 2;
/** 追问一轮的消耗权重。 */
const CLARIFY_WEIGHT = 1;
/** 项目基线最少样本：不足时优势记 0（冷启动保守，排序退回时间序）。 */
const MIN_BASELINE_TASKS = 3;
/** 收缩先验：票数少时平均优势向 0 收缩，防止一两次好运记忆压过长期稳定记忆。 */
const SHRINK_K = 5;

export function loadContextMemories(db: DB, input: {
  profileId: string; projectId: string; limit?: number;
/**
   * 渐进式加载：当传入 query 时，workspace/project 记忆仅注入与当前任务相关的（词元级 LIKE + FTS5 命中），
   * 避免把全量记忆塞进 system prompt 淹没上下文；为空则回退全量（按 scope 优先级）。
   * 注意：personal 是用户的稳定偏好与核心身份，**永远全量注入**，不受 query 筛选——
   * 否则 agent 会因任务不相关而忘记用户的固定偏好（如"用中文回复"）。
 * 蓝图组织批次1：craft 记忆按人设过滤——任务穿戴人设时注入「该人设的方法论 + 通用技能记忆」，
 * 不穿戴时只注入通用技能记忆（persona_key IS NULL）。人设方法论不污染无人设任务。
 * 人设方法论（persona_key 非空）按 persona_key 全局召回（不分 profile 归属）——
 * 方法论属于人设：蜂群专家蜂沉淀的 CRAFT 与固定员工沉淀的同池复用。
   * 不引入 embedding/向量——复用 searchMemory 已验证的 FTS5 路径即可。
   */
  query?: string;
  /** 当前任务穿戴的人设（task.personaId）；null/undefined = 无人设。 */
  personaKey?: string | null;
  /** 记忆优势分：传入执行任务 id 时，对本次注入的非 personal 记忆记账（hit_count + memory_injection）。 */
  taskId?: string | null;
}): MemoryEntry[] {
  const now = nowIso();
  const trimmedQuery = (input.query ?? '').trim();
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
  // 排序：scope 优先级不变；同级内按收缩平均优势（adv_sum/(vote_count+5)，零票=0 退回时间序），
  // 新记忆靠 updated_at 时间序保底出场（探索通道），老而准的记忆靠战绩稳压新而平庸的；
  // id 兜底保证同毫秒创建的记忆排序确定。
  const orderClause = `CASE scope WHEN 'personal' THEN 1 WHEN 'workspace' THEN 2 WHEN 'project' THEN 3 ELSE 4 END, adv_sum * 1.0 / (vote_count + ${SHRINK_K}) DESC, updated_at DESC, id`;
  // craft 分支：人设方法论（persona_key 非空）按 persona_key 全局召回——方法论属于人设不属于执行者，
  // 蜂群专家蜂沉淀的 CRAFT 挂在人设档案宿主上，任何穿戴同款人设的执行体都能读到；
  // 通用技能记忆（persona_key IS NULL）仍按 profile 隔离（个人手艺不外泄）。
  const craftClause = input.personaKey
    ? "(scope='craft' AND ((persona_key IS NULL AND profile_id=?) OR persona_key=?))"
    : "(scope='craft' AND persona_key IS NULL AND profile_id=?)";
  // query 为空 → 原全量逻辑（向后兼容，零破坏）。
  if (!trimmedQuery) {
    const fullValues: unknown[] = [now, input.profileId];
    if (input.personaKey) fullValues.push(input.profileId, input.personaKey);
    else fullValues.push(input.profileId);
    fullValues.push(input.profileId, input.projectId, limit);
    const rows = db.prepare(
      `SELECT * FROM memory_entry
       WHERE state IN ('active','locked')
         AND can_influence=1 AND (expires_at IS NULL OR expires_at > ?)
         AND (
           -- 修复轮（批次 F 定案 #8）：personal=用户偏好，去掉 profile/project 过滤——乙能读到甲沉淀的用户偏好
           (scope='personal')
           OR (scope='workspace' AND profile_id=?)
           OR ${craftClause}
           OR (scope='project' AND profile_id=? AND project_id=?)
         )
       ORDER BY ${orderClause} LIMIT ?`,
    ).all(...fullValues) as EntryRow[];
    markCompactionDirty(db, rows);
    return recordInjected(db, input.taskId, applyInjectBudget(rows.map((row) => entryFromRow(db, row))));
  }
  // query 非空 → personal/craft 仍全量（craft 按人设过滤）；workspace/project 仅注入相关记忆。
  // 每个词元独立 OR 命中（英文整词、中文整段 + 二元组），既渐进又不丢用户的稳定偏好。
  const tokens = expandMatchTokens(trimmedQuery);
  const matchOrs = tokens
    .map(() => '(content LIKE ? OR id IN (SELECT entry_id FROM memory_fts WHERE memory_fts MATCH ?))')
    .join(' OR ');
  const values: unknown[] = [now];
  if (input.personaKey) values.push(input.profileId, input.personaKey);
  else values.push(input.profileId);
  values.push(input.profileId, input.profileId, input.projectId);
  for (const token of tokens) {
    values.push(`%${token}%`, `${escapeFtsQuery(token)}*`);
  }
  values.push(limit);
  const rows = db.prepare(
    `SELECT * FROM memory_entry
     WHERE state IN ('active','locked')
       AND can_influence=1 AND (expires_at IS NULL OR expires_at > ?)
       AND (
         (scope='personal')
         OR ${craftClause}
         OR ((scope='workspace' AND profile_id=?) OR (scope='project' AND profile_id=? AND project_id=?))
             AND (${matchOrs})
       )
     ORDER BY ${orderClause} LIMIT ?`,
  ).all(...values) as EntryRow[];
  markCompactionDirty(db, rows);
  return recordInjected(db, input.taskId, applyInjectBudget(rows.map((row) => entryFromRow(db, row))));
}

/**
 * 注入预算（P0-②）：条数 limit 之外再加字符双控——personal 段 ≤2000 字符且 ≤12 条（personal 排序第一优先，
 * 无上限时会挤占整个注入配额），其余段合计 ≤4000 字符。按既有排序保序截断，预算尽的条目直接出列
 * （不出场即不记账，优势分不被无辜稀释）。
 */
function applyInjectBudget(entries: MemoryEntry[]): MemoryEntry[] {
  let personalChars = 0;
  let restChars = 0;
  let personalCount = 0;
  return entries.filter((entry) => {
    if (entry.scope === 'personal') {
      if (personalCount >= MEMORY_INJECT_PERSONAL_MAX_ENTRIES) return false;
      if (personalChars + entry.content.length > MEMORY_INJECT_PERSONAL_CHAR_BUDGET) return false;
      personalChars += entry.content.length;
      personalCount += 1;
      return true;
    }
    if (restChars + entry.content.length > MEMORY_INJECT_REST_CHAR_BUDGET) return false;
    restChars += entry.content.length;
    return true;
  });
}

/**
 * 记忆优势分：本次注入记账（调用方传了 taskId 时）。
 * personal 豁免——用户偏好由用户背书，不参与任务结果投票；(task, entry) 唯一，
 * waiting_input 恢复后重新装配上下文不会重复计数；后轮新命中的记忆会补记（它后来也参与了）。
 */
function recordInjected(db: DB, taskId: string | null | undefined, entries: MemoryEntry[]): MemoryEntry[] {
  if (!taskId) return entries;
  const injectable = entries.filter((entry) => entry.scope !== 'personal');
  if (injectable.length === 0) return entries;
  const insert = db.prepare('INSERT OR IGNORE INTO memory_injection (task_id, entry_id, injected_at) VALUES (?, ?, ?)');
  const bump = db.prepare('UPDATE memory_entry SET hit_count = hit_count + 1 WHERE id = ?');
  db.transaction(() => {
    const now = nowIso();
    for (const entry of injectable) {
      if (insert.run(taskId, entry.id, now).changes === 1) bump.run(entry.id);
    }
  })();
  return entries;
}

/**
 * 记忆优势分：结算终态任务的注入投票（惰性结算，10s 定时器调用）。
 * 不挂反思队列——反思在任务首次 waiting_input 就入队消耗 task_id UNIQUE（engine.ts:1100），
 * 挂那里会在任务半程投票失真；这里扫描"任务已到真正终态（completed/failed）且存在未投票注入"的记录。
 * 每任务单事务：消耗分 = 返工×2 + 追问×1 → 项目基线（该项目已结算任务的平均消耗，样本≥3 才启用）→
 * 优势 = 基线 − 消耗（completed 记票；failed 投中性 0 票，失败原因不明不冤枉不奖励）→
 * 累计到每条注入记忆并标 voted_at。voted_at 守卫保证恰好一次：崩溃后重扫不重复计票。
 * 基线先算后累加（本任务不稀释自身基线）；failed 不计入基线（基线=正常完成水平）。
 *
 * 扫描即过滤（review 修复两处）：
 * 1. 终态过滤放 SQL 而不是循环里 continue——永久 waiting/cancelled 的任务注入时间最早，
 *    会永远占满 LIMIT 窗口饿死后来的终态任务（结算静默停摆）。
 * 2. 验收未闭环推迟结算——验收返工的 rework_count 在源任务完成后才落（acceptance-review.ts
 *    先加计数再发 acceptance_rework 事件），10s 就结算会读到 0 漏记成本。已派验收
 *    （acceptance_dispatched）且未落闭环事件（passed/rework/escalated）且验收任务还活着 → 推迟；
 *    验收任务死亡（失败/取消）= 事后门放行语义，rework_count 已是终值，正常结算。
 */
export function settleMemoryVotes(db: DB, options: { maxTasks?: number } = {}): number {
  const maxTasks = Math.min(Math.max(options.maxTasks ?? 20, 1), 100);
  const pending = db.prepare(
    `SELECT mi.task_id
     FROM memory_injection mi
     JOIN task t ON t.id = mi.task_id
     WHERE mi.voted_at IS NULL AND t.state IN ('completed','failed')
       AND NOT EXISTS (
         SELECT 1 FROM task_event de
         WHERE de.task_id = t.id AND de.kind = 'acceptance_dispatched'
           AND NOT EXISTS (
             SELECT 1 FROM task_event te
             WHERE te.task_id = t.id
               AND te.kind IN ('acceptance_passed','acceptance_rework','acceptance_escalated')
           )
           AND EXISTS (
             SELECT 1 FROM task rt
             WHERE rt.id = json_extract(de.payload_json, '$.reviewTaskId')
               AND rt.state NOT IN ('completed','failed','cancelled')
           )
       )
     GROUP BY mi.task_id ORDER BY MIN(mi.injected_at) LIMIT ?`,
  ).all(maxTasks) as Array<{ task_id: string }>;
  let voted = 0;
  for (const { task_id } of pending) {
    const task = db.prepare(
      'SELECT state, rework_count, clarification_rounds, project_id FROM task WHERE id=?',
    ).get(task_id) as
      | { state: string; rework_count: number; clarification_rounds: number; project_id: string }
      | undefined;
    if (!task) continue; // task 已删（级联清注入行，正常不可达）
    if (task.state !== 'completed' && task.state !== 'failed') continue; // 中途/等待输入等未终态
    voted += db.transaction(() => {
      const stat = db.prepare('SELECT task_count, cost_sum FROM project_cost_stat WHERE project_id=?')
        .get(task.project_id) as { task_count: number; cost_sum: number } | undefined;
      const cost = task.rework_count * REWORK_WEIGHT + task.clarification_rounds * CLARIFY_WEIGHT;
      let advantage = 0;
      if (task.state === 'completed' && stat && stat.task_count >= MIN_BASELINE_TASKS) {
        advantage = stat.cost_sum / stat.task_count - cost;
      }
      const rows = db.prepare('SELECT entry_id FROM memory_injection WHERE task_id=? AND voted_at IS NULL')
        .all(task_id) as Array<{ entry_id: string }>;
      if (rows.length === 0) return 0;
      const updateEntry = db.prepare('UPDATE memory_entry SET vote_count = vote_count + 1, adv_sum = adv_sum + ? WHERE id = ?');
      const markVoted = db.prepare('UPDATE memory_injection SET voted_at=? WHERE task_id=? AND voted_at IS NULL');
      for (const row of rows) updateEntry.run(advantage, row.entry_id);
      markVoted.run(nowIso(), task_id);
      if (task.state === 'completed') {
        if (stat) {
          db.prepare('UPDATE project_cost_stat SET task_count = task_count + 1, cost_sum = cost_sum + ? WHERE project_id=?')
            .run(cost, task.project_id);
        } else {
          db.prepare('INSERT INTO project_cost_stat (project_id, task_count, cost_sum) VALUES (?, 1, ?)')
            .run(task.project_id, cost);
        }
      }
      return rows.length;
    })();
  }
  return voted;
}

export function flushThreadMemory(db: DB, input: {
  threadId: string; content: string; sourceTaskId?: string;
}): MemoryCandidate | null {
  const content = input.content.trim();
  if (!content) return null;
  const row = db.prepare(
    `SELECT a.profile_id, t.project_id
     FROM project_agent_thread t
     JOIN agent_definition a ON a.id=t.agent_id
     WHERE t.id=?`,
  ).get(input.threadId) as { profile_id: string; project_id: string } | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `thread ${input.threadId} not found`);
  return createMemoryCandidate(db, {
    profileId: row.profile_id,
    scope: 'project',
    projectId: row.project_id,
    content,
    sourceTaskId: input.sourceTaskId,
    author: 'agent',
    confidence: 0.9,
    canInfluence: true,
    allowAutoApprove: true,
  });
}

function validateScope(scope: MemoryScope, projectId?: string): void {
  if (scope === 'project' && !projectId) throw new AppError(ErrorCode.VALIDATION, '项目记忆必须指定项目');
  if ((scope === 'personal' || scope === 'craft') && projectId) {
    throw new AppError(ErrorCode.VALIDATION, '个人或 Skill 记忆不能绑定项目');
  }
}

/** 注入扫描（正则系）：命中返回拒绝理由，null=安全。R6a 技能导入等内容入口复用。 */
export function scanMemoryContent(content: string): string | null {
  const patterns = [
    /ignore (all |any )?(previous|prior) instructions?/i,
    /忽略.{0,8}(之前|先前|以上).{0,8}(指令|提示)/i,
    /(?:api|secret|access)[_-]?key/i,
    /读取.{0,12}(密钥|凭据|token)/i,
    /(?:send|upload|exfiltrate).{0,20}(secret|credential|token)/i,
    /发到.{0,12}(外部|服务器|网址)/i,
  ];
  return patterns.some((pattern) => pattern.test(content)) ? '内容需要安全审查，不能自动影响未来操作' : null;
}

function insertMemoryVersion(
  db: DB, entryId: string, version: number, content: string, changedBy: string,
  sourceCandidateId: string | null, createdAt: string,
): void {
  db.prepare(
    `INSERT INTO memory_version (id, entry_id, version, content, changed_by, source_candidate_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(shortId('mv_'), entryId, version, content, changedBy, sourceCandidateId, createdAt);
}

function indexMemory(db: DB, entryId: string, profileId: string, content: string): void {
  db.prepare('DELETE FROM memory_fts WHERE entry_id=?').run(entryId);
  db.prepare('INSERT INTO memory_fts (entry_id, profile_id, content) VALUES (?, ?, ?)').run(entryId, profileId, content);
}

/** 转义为 FTS5 短语查询（供归档检索复用）。 */
export function escapeFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

export function copyPersonalMemoryEntries(db: DB, sourceProfileId: string, targetProfileId: string): MemoryEntry[] {
  getAgentProfile(db, sourceProfileId);
  getAgentProfile(db, targetProfileId);
  const sourceEntries = listMemoryEntries(db, { profileId: sourceProfileId, scope: 'personal' })
    .filter((entry) => entry.state === 'active' || entry.state === 'locked');
  const copies: MemoryEntry[] = [];
  for (const source of sourceEntries) {
    const candidate = createMemoryCandidate(db, {
      profileId: targetProfileId,
      scope: 'personal',
      content: source.content,
      author: 'user',
      confidence: 1,
      canInfluence: source.canInfluence,
      expiresAt: source.expiresAt ?? undefined,
      allowAutoApprove: true,
      fingerprint: source.fingerprint,
    });
    const entry = db.prepare('SELECT * FROM memory_entry WHERE source_candidate_id=?').get(candidate.id) as EntryRow | undefined;
    if (entry) copies.push(entryFromRow(db, entry));
  }
  return copies;
}

export function resetPersonalMemory(db: DB, profileId: string, changedBy: string): number {
  getAgentProfile(db, profileId);
  const entries = listMemoryEntries(db, { profileId, scope: 'personal' });
  const now = nowIso();
  db.transaction(() => {
    for (const entry of entries) {
      db.prepare("UPDATE memory_entry SET state='deleted', updated_at=? WHERE id=?").run(now, entry.id);
      db.prepare('DELETE FROM memory_fts WHERE entry_id=?').run(entry.id);
      insertMemoryVersion(db, entry.id, entry.version + 1, entry.content, `${changedBy}:reset-personal`, null, now);
    }
  })();
  return entries.length;
}

// ===== P0-④ 记忆库卫生（候选积压提醒 + 过期物理清理）=====

/** 积压提醒门槛：待审候选超过该条数、或最老的等待超过该天数，提醒用户处理。 */
export const MEMORY_BACKLOG_COUNT_THRESHOLD = 20;
export const MEMORY_BACKLOG_AGE_DAYS = 7;

/**
 * 候选积压巡检（纯查询）：pending 过量或过老时返回提醒文案（调用方负责发系统消息+自行节流），
 * 无积压返回 null。此前低置信候选静默进 pending 无任何提醒，容易长期无人处理。
 */
export function sweepMemoryBacklogNotice(db: DB): string | null {
  const stats = db.prepare(
    "SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM memory_candidate WHERE status='pending'",
  ).get() as { c: number; oldest: string | null };
  if (stats.c === 0 || !stats.oldest) return null;
  const oldestAgeDays = (Date.now() - Date.parse(stats.oldest)) / 86_400_000;
  if (stats.c <= MEMORY_BACKLOG_COUNT_THRESHOLD && oldestAgeDays <= MEMORY_BACKLOG_AGE_DAYS) return null;
  const reason = stats.c > MEMORY_BACKLOG_COUNT_THRESHOLD
    ? `待确认 ${stats.c} 条（超过 ${MEMORY_BACKLOG_COUNT_THRESHOLD} 条）`
    : `最老一条已等待 ${Math.floor(oldestAgeDays)} 天`;
  return `⚠️ 记忆候选积压：${reason}。请到员工档案页·记忆中心处理——长期未审的候选不会注入也不会淘汰，只占着队列。`;
}

/**
 * 过期物理清理：软删超 90 天、expires_at 过期超 30 天的条目收尸（读路径早已过滤它们，
 * 这里只是防表无限膨胀）。连带清 version/fts/injection 子表；审计痕随主行删除——
 * 物理删除前该条的历史版本已在保留期内可查。返回清理计数。
 * Review P2-3：每批 500 条分批事务——长期运行后首次清理可能数万行，单个同步大事务会阻塞事件循环。
 */
export const MEMORY_PURGE_BATCH = 500;
export function purgeStaleMemory(db: DB, options: { deletedOlderThanDays?: number; expiredGraceDays?: number; maxRows?: number } = {}): { purgedDeleted: number; purgedExpired: number } {
  const deletedCutoff = new Date(Date.now() - (options.deletedOlderThanDays ?? 90) * 86_400_000).toISOString();
  const expiredCutoff = new Date(Date.now() - (options.expiredGraceDays ?? 30) * 86_400_000).toISOString();
  const cap = options.maxRows ?? 5000; // 单次调用总量上限（防一次清太久），余量下轮卫生定时器继续
  const deletedIds = (db.prepare("SELECT id FROM memory_entry WHERE state='deleted' AND updated_at < ? LIMIT ?").all(deletedCutoff, cap) as Array<{ id: string }>).map((r) => r.id);
  const remaining = cap - deletedIds.length;
  const expiredIds = remaining > 0
    ? (db.prepare('SELECT id FROM memory_entry WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT ?').all(expiredCutoff, remaining) as Array<{ id: string }>).map((r) => r.id)
    : [];
  const all = [...new Set([...deletedIds, ...expiredIds])];
  if (all.length === 0) return { purgedDeleted: 0, purgedExpired: 0 };
  for (let i = 0; i < all.length; i += MEMORY_PURGE_BATCH) {
    const batch = all.slice(i, i + MEMORY_PURGE_BATCH);
    db.transaction(() => {
      for (const id of batch) {
        db.prepare('DELETE FROM memory_injection WHERE entry_id=?').run(id);
        db.prepare('DELETE FROM memory_version WHERE entry_id=?').run(id);
        db.prepare('DELETE FROM memory_fts WHERE entry_id=?').run(id);
        db.prepare('DELETE FROM memory_entry WHERE id=?').run(id);
      }
    })();
  }
  return { purgedDeleted: deletedIds.length, purgedExpired: expiredIds.length };
}
