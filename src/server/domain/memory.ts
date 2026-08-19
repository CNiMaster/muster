import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { getAgentProfile, ensurePersonaArchiveProfile } from './agent-profile';
import { getWorkbenchOrNull } from './workbench';

export type MemoryScope = 'personal' | 'company' | 'project' | 'skill';
export type MemoryCandidateStatus = 'pending' | 'approved' | 'rejected';
export type MemoryEntryState = 'active' | 'locked' | 'superseded' | 'deleted';

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
  /** 蓝图组织批次1：人设键（skill scope 的方法论归属，如 'product/product-manager'）；仅 skill scope 允许非空。 */
  personaKey: string | null;
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
  /** 蓝图组织批次1：人设键（skill scope 专属）；null = 通用技能记忆。 */
  personaKey: string | null;
  /** 记忆优势分：注入次数（记录在案的任务上下文出场）。 */
  hitCount: number;
  /** 记忆优势分：已结算的终态投票数（收缩平均的分母）。 */
  voteCount: number;
  /** 记忆优势分：优势分累计（每票 = 项目基线 − 任务消耗）。 */
  advSum: number;
}

type CandidateRow = {
  id: string; profile_id: string; scope: MemoryScope; project_id: string | null;
  content: string; source_task_id: string | null; source_message_id: string | null; author: string;
  confidence: number; can_influence: number; status: MemoryCandidateStatus; quarantine_reason: string | null;
  expires_at: string | null; reviewed_by: string | null; reviewed_at: string | null; created_at: string;
  fingerprint: string | null; persona_key: string | null;
};
type EntryRow = {
  id: string; profile_id: string; scope: MemoryScope; project_id: string | null;
  content: string; version: number; state: MemoryEntryState; can_influence: number;
  source_candidate_id: string | null; expires_at: string | null; created_at: string; updated_at: string;
  fingerprint: string | null; persona_key: string | null;
  hit_count: number; vote_count: number; adv_sum: number;
};

function candidateFromRow(_db: DB, row: CandidateRow): MemoryCandidate {
  return {
    id: row.id, profileId: row.profile_id, scope: row.scope, projectId: row.project_id,
    content: row.content, sourceTaskId: row.source_task_id, sourceMessageId: row.source_message_id,
    author: row.author, confidence: row.confidence, canInfluence: row.can_influence === 1, status: row.status,
    quarantineReason: row.quarantine_reason, expiresAt: row.expires_at, reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at, createdAt: row.created_at, fingerprint: row.fingerprint,
    personaKey: row.persona_key ?? null,
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
  };
}

export function createMemoryCandidate(db: DB, input: {
  profileId: string; scope: MemoryScope; projectId?: string; content: string;
  sourceTaskId?: string; sourceMessageId?: string; author: string; confidence: number;
  canInfluence: boolean; expiresAt?: string; allowAutoApprove?: boolean;
  /** E2.1 结构化 category 标签（形如 "design:color"），供晋升流聚类；省略则无标签。 */
  fingerprint?: string | null;
  /** 蓝图组织批次1：人设键——skill scope 的方法论归属（如 'product/product-manager'）。仅 skill scope 允许。 */
  personaKey?: string;
}): MemoryCandidate {
  getAgentProfile(db, input.profileId);
  validateScope(input.scope, input.projectId);
  if (input.personaKey && input.scope !== 'skill') {
    throw new AppError(ErrorCode.VALIDATION, '人设键只允许用于 skill 记忆（方法论挂在人设上）');
  }
  const content = input.content.trim();
  if (!content) throw new AppError(ErrorCode.VALIDATION, '记忆内容不能为空');
  if (input.confidence < 0 || input.confidence > 1) throw new AppError(ErrorCode.VALIDATION, '记忆可信度必须在 0 到 1 之间');
  const quarantineReason = scanMemoryContent(content);
  const id = shortId('mc_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO memory_candidate (
      id, profile_id, scope, project_id, content, source_task_id, source_message_id,
      author, confidence, can_influence, status, quarantine_reason, expires_at, created_at, fingerprint, persona_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(
    id, input.profileId, input.scope, input.projectId ?? null, content,
    input.sourceTaskId ?? null, input.sourceMessageId ?? null, input.author, input.confidence,
    input.canInfluence ? 1 : 0, quarantineReason, input.expiresAt ?? null, now, input.fingerprint ?? null,
    input.personaKey ?? null,
  );
  const canAutoApprove = !quarantineReason && input.allowAutoApprove === true && (
    input.scope === 'project'
    || input.author === 'user'
    // 蓝图组织批次1：人设键方法论是自包含的领域经验（不绑定公司/项目事实），高置信允许自动生效。
    || (input.scope === 'skill' && !!input.personaKey)
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
        can_influence, source_candidate_id, expires_at, created_at, updated_at, fingerprint, persona_key
      ) VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entryId, candidate.profileId, candidate.scope, candidate.projectId,
      candidate.content, candidate.canInfluence ? 1 : 0, candidate.id, candidate.expiresAt, now, now, candidate.fingerprint,
      candidate.personaKey,
    );
    insertMemoryVersion(db, entryId, 1, candidate.content, reviewer, candidate.id, now);
    indexMemory(db, entryId, candidate.profileId, candidate.content);
    return getMemoryEntry(db, entryId);
  })();
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
  profileId: string; scope?: MemoryScope; projectId?: string; includeDeleted?: boolean;
}): MemoryEntry[] {
  const clauses = ['profile_id=?'];
  const values: unknown[] = [filter.profileId];
  if (filter.scope) { clauses.push('scope=?'); values.push(filter.scope); }
  if (filter.projectId) { clauses.push('project_id=?'); values.push(filter.projectId); }
  if (!filter.includeDeleted) clauses.push("state!='deleted'");
  return (db.prepare(`SELECT * FROM memory_entry WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, id`).all(...values) as EntryRow[])
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
 * 只迁移 skill+persona_key 行（含候选）；personal/project 记忆与临时执行体绑定，随删。
 */
export function preservePersonaCraftMemories(db: DB, fromProfileId: string): number {
  const to = ensurePersonaArchiveProfile(db);
  const entries = db
    .prepare(`UPDATE memory_entry SET profile_id=? WHERE profile_id=? AND scope='skill' AND persona_key IS NOT NULL`)
    .run(to, fromProfileId).changes;
  const candidates = db
    .prepare(`UPDATE memory_candidate SET profile_id=? WHERE profile_id=? AND scope='skill' AND persona_key IS NOT NULL`)
    .run(to, fromProfileId).changes;
  return entries + candidates;
}

export function searchMemory(db: DB, input: {
  profileId: string; query: string; projectId?: string; limit?: number;
}): MemoryEntry[] {  const query = input.query.trim();
  if (!query) return [];
  const now = nowIso();
  const rows = db.prepare(
    `SELECT DISTINCT m.* FROM memory_entry m
     WHERE m.profile_id=? AND m.state IN ('active','locked')
       AND (m.expires_at IS NULL OR m.expires_at > ?)
       AND (
         m.scope IN ('personal','skill')
         OR (m.scope='company')
         OR (m.scope='project' AND m.project_id=?)
       )
       AND (m.content LIKE ? OR m.id IN (SELECT entry_id FROM memory_fts WHERE memory_fts MATCH ?))
     ORDER BY m.updated_at DESC LIMIT ?`,
  ).all(
    input.profileId, now, input.projectId ?? null,
    `%${query}%`, `${escapeFtsQuery(query)}*`, Math.min(Math.max(input.limit ?? 8, 1), 50),
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
  return tokens;
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
   * 渐进式加载：当传入 query 时，company/project 记忆仅注入与当前任务相关的（词元级 LIKE + FTS5 命中），
   * 避免把全量记忆塞进 system prompt 淹没上下文；为空则回退全量（按 scope 优先级）。
   * 注意：personal 是用户的稳定偏好与核心身份，**永远全量注入**，不受 query 筛选——
   * 否则 agent 会因任务不相关而忘记用户的固定偏好（如"用中文回复"）。
 * 蓝图组织批次1：skill 记忆按人设过滤——任务穿戴人设时注入「该人设的方法论 + 通用技能记忆」，
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
  const orderClause = `CASE scope WHEN 'personal' THEN 1 WHEN 'company' THEN 2 WHEN 'project' THEN 3 ELSE 4 END, adv_sum * 1.0 / (vote_count + ${SHRINK_K}) DESC, updated_at DESC, id`;
  // skill 分支：人设方法论（persona_key 非空）按 persona_key 全局召回——方法论属于人设不属于执行者，
  // 蜂群专家蜂沉淀的 CRAFT 挂在人设档案宿主上，任何穿戴同款人设的执行体都能读到；
  // 通用技能记忆（persona_key IS NULL）仍按 profile 隔离（个人手艺不外泄）。
  const skillClause = input.personaKey
    ? "(scope='skill' AND ((persona_key IS NULL AND profile_id=?) OR persona_key=?))"
    : "(scope='skill' AND persona_key IS NULL AND profile_id=?)";
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
           (scope IN ('personal','company') AND profile_id=?)
           OR ${skillClause}
           OR (scope='project' AND profile_id=? AND project_id=?)
         )
       ORDER BY ${orderClause} LIMIT ?`,
    ).all(...fullValues) as EntryRow[];
    return recordInjected(db, input.taskId, rows.map((row) => entryFromRow(db, row)));
  }
  // query 非空 → personal/skill 仍全量（skill 按人设过滤）；company/project 仅注入相关记忆。
  // 每个词元独立 OR 命中（英文整词、中文整段 + 二元组），既渐进又不丢用户的稳定偏好。
  const tokens = expandMatchTokens(trimmedQuery);
  const matchOrs = tokens
    .map(() => '(content LIKE ? OR id IN (SELECT entry_id FROM memory_fts WHERE memory_fts MATCH ?))')
    .join(' OR ');
  const values: unknown[] = [now, input.profileId];
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
         (scope='personal' AND profile_id=?)
         OR ${skillClause}
         OR ((scope='company' AND profile_id=?) OR (scope='project' AND profile_id=? AND project_id=?))
             AND (${matchOrs})
       )
     ORDER BY ${orderClause} LIMIT ?`,
  ).all(...values) as EntryRow[];
  return recordInjected(db, input.taskId, rows.map((row) => entryFromRow(db, row)));
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
  if ((scope === 'personal' || scope === 'skill') && projectId) {
    throw new AppError(ErrorCode.VALIDATION, '个人或 Skill 记忆不能绑定项目');
  }
}

function scanMemoryContent(content: string): string | null {
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
