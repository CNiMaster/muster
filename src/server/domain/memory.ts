import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { getAgentProfile } from './agent-profile';

export type MemoryScope = 'personal' | 'company' | 'project' | 'skill';
export type MemoryCandidateStatus = 'pending' | 'approved' | 'rejected';
export type MemoryEntryState = 'active' | 'locked' | 'superseded' | 'deleted';

export interface MemoryCandidate {
  id: string;
  profileId: string;
  scope: MemoryScope;
  companyId: string | null;
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
}

export interface MemoryEntry {
  id: string;
  profileId: string;
  scope: MemoryScope;
  companyId: string | null;
  projectId: string | null;
  content: string;
  version: number;
  state: MemoryEntryState;
  canInfluence: boolean;
  sourceCandidateId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type CandidateRow = {
  id: string; profile_id: string; scope: MemoryScope; company_id: string | null; project_id: string | null;
  content: string; source_task_id: string | null; source_message_id: string | null; author: string;
  confidence: number; can_influence: number; status: MemoryCandidateStatus; quarantine_reason: string | null;
  expires_at: string | null; reviewed_by: string | null; reviewed_at: string | null; created_at: string;
};
type EntryRow = {
  id: string; profile_id: string; scope: MemoryScope; company_id: string | null; project_id: string | null;
  content: string; version: number; state: MemoryEntryState; can_influence: number;
  source_candidate_id: string | null; expires_at: string | null; created_at: string; updated_at: string;
};

function candidateFromRow(row: CandidateRow): MemoryCandidate {
  return {
    id: row.id, profileId: row.profile_id, scope: row.scope, companyId: row.company_id, projectId: row.project_id,
    content: row.content, sourceTaskId: row.source_task_id, sourceMessageId: row.source_message_id,
    author: row.author, confidence: row.confidence, canInfluence: row.can_influence === 1, status: row.status,
    quarantineReason: row.quarantine_reason, expiresAt: row.expires_at, reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at, createdAt: row.created_at,
  };
}

function entryFromRow(row: EntryRow): MemoryEntry {
  return {
    id: row.id, profileId: row.profile_id, scope: row.scope, companyId: row.company_id, projectId: row.project_id,
    content: row.content, version: row.version, state: row.state, canInfluence: row.can_influence === 1,
    sourceCandidateId: row.source_candidate_id, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createMemoryCandidate(db: DB, input: {
  profileId: string; scope: MemoryScope; companyId?: string; projectId?: string; content: string;
  sourceTaskId?: string; sourceMessageId?: string; author: string; confidence: number;
  canInfluence: boolean; expiresAt?: string; allowAutoApprove?: boolean;
}): MemoryCandidate {
  getAgentProfile(db, input.profileId);
  validateScope(input.scope, input.companyId, input.projectId);
  const content = input.content.trim();
  if (!content) throw new AppError(ErrorCode.VALIDATION, '记忆内容不能为空');
  if (input.confidence < 0 || input.confidence > 1) throw new AppError(ErrorCode.VALIDATION, '记忆可信度必须在 0 到 1 之间');
  const quarantineReason = scanMemoryContent(content);
  const id = shortId('mc_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO memory_candidate (
      id, profile_id, scope, company_id, project_id, content, source_task_id, source_message_id,
      author, confidence, can_influence, status, quarantine_reason, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id, input.profileId, input.scope, input.companyId ?? null, input.projectId ?? null, content,
    input.sourceTaskId ?? null, input.sourceMessageId ?? null, input.author, input.confidence,
    input.canInfluence ? 1 : 0, quarantineReason, input.expiresAt ?? null, now,
  );
  const canAutoApprove = !quarantineReason && input.allowAutoApprove === true && (
    input.scope === 'project' || input.author === 'user'
  );
  if (canAutoApprove) approveMemoryCandidate(db, id, input.author);
  return getMemoryCandidate(db, id);
}

export function getMemoryCandidate(db: DB, id: string): MemoryCandidate {
  const row = db.prepare('SELECT * FROM memory_candidate WHERE id=?').get(id) as CandidateRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `memory candidate ${id} not found`);
  return candidateFromRow(row);
}

export function listMemoryCandidates(db: DB, filter: { profileId: string; status?: MemoryCandidateStatus }): MemoryCandidate[] {
  const rows = filter.status
    ? db.prepare('SELECT * FROM memory_candidate WHERE profile_id=? AND status=? ORDER BY created_at, id').all(filter.profileId, filter.status)
    : db.prepare('SELECT * FROM memory_candidate WHERE profile_id=? ORDER BY created_at, id').all(filter.profileId);
  return (rows as CandidateRow[]).map(candidateFromRow);
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
        id, profile_id, scope, company_id, project_id, content, version, state,
        can_influence, source_candidate_id, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?)`,
    ).run(
      entryId, candidate.profileId, candidate.scope, candidate.companyId, candidate.projectId,
      candidate.content, candidate.canInfluence ? 1 : 0, candidate.id, candidate.expiresAt, now, now,
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
  return entryFromRow(row);
}

export function listMemoryEntries(db: DB, filter: {
  profileId: string; scope?: MemoryScope; companyId?: string; projectId?: string; includeDeleted?: boolean;
}): MemoryEntry[] {
  const clauses = ['profile_id=?'];
  const values: unknown[] = [filter.profileId];
  if (filter.scope) { clauses.push('scope=?'); values.push(filter.scope); }
  if (filter.companyId) { clauses.push('company_id=?'); values.push(filter.companyId); }
  if (filter.projectId) { clauses.push('project_id=?'); values.push(filter.projectId); }
  if (!filter.includeDeleted) clauses.push("state!='deleted'");
  return (db.prepare(`SELECT * FROM memory_entry WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, id`).all(...values) as EntryRow[])
    .map(entryFromRow);
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

export function searchMemory(db: DB, input: {
  profileId: string; query: string; companyId?: string; projectId?: string; limit?: number;
}): MemoryEntry[] {
  const query = input.query.trim();
  if (!query) return [];
  const now = nowIso();
  const rows = db.prepare(
    `SELECT DISTINCT m.* FROM memory_entry m
     WHERE m.profile_id=? AND m.state IN ('active','locked')
       AND (m.expires_at IS NULL OR m.expires_at > ?)
       AND (
         m.scope IN ('personal','skill')
         OR (m.scope='company' AND m.company_id=?)
         OR (m.scope='project' AND m.company_id=? AND m.project_id=?)
       )
       AND (m.content LIKE ? OR m.id IN (SELECT entry_id FROM memory_fts WHERE memory_fts MATCH ?))
     ORDER BY m.updated_at DESC LIMIT ?`,
  ).all(
    input.profileId, now, input.companyId ?? null, input.companyId ?? null, input.projectId ?? null,
    `%${query}%`, `${escapeFtsQuery(query)}*`, Math.min(Math.max(input.limit ?? 8, 1), 50),
  ) as EntryRow[];
  return rows.map(entryFromRow);
}

export function loadContextMemories(db: DB, input: {
  profileId: string; companyId: string; projectId: string; limit?: number;
}): MemoryEntry[] {
  const now = nowIso();
  return (db.prepare(
    `SELECT * FROM memory_entry
     WHERE profile_id=? AND state IN ('active','locked')
       AND can_influence=1 AND (expires_at IS NULL OR expires_at > ?)
       AND (
         scope IN ('personal','skill')
         OR (scope='company' AND company_id=?)
         OR (scope='project' AND company_id=? AND project_id=?)
       )
     ORDER BY CASE scope WHEN 'personal' THEN 1 WHEN 'company' THEN 2 WHEN 'project' THEN 3 ELSE 4 END,
       updated_at DESC LIMIT ?`,
  ).all(
    input.profileId, now, input.companyId, input.companyId, input.projectId,
    Math.min(Math.max(input.limit ?? 8, 1), 20),
  ) as EntryRow[]).map(entryFromRow);
}

export function flushThreadMemory(db: DB, input: {
  threadId: string; content: string; sourceTaskId?: string;
}): MemoryCandidate | null {
  const content = input.content.trim();
  if (!content) return null;
  const row = db.prepare(
    `SELECT a.profile_id, p.company_id, t.project_id
     FROM project_agent_thread t
     JOIN agent_definition a ON a.id=t.agent_id
     JOIN project p ON p.id=t.project_id
     WHERE t.id=?`,
  ).get(input.threadId) as { profile_id: string; company_id: string; project_id: string } | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `thread ${input.threadId} not found`);
  return createMemoryCandidate(db, {
    profileId: row.profile_id,
    scope: 'project',
    companyId: row.company_id,
    projectId: row.project_id,
    content,
    sourceTaskId: input.sourceTaskId,
    author: 'agent',
    confidence: 0.9,
    canInfluence: true,
    allowAutoApprove: true,
  });
}

function validateScope(scope: MemoryScope, companyId?: string, projectId?: string): void {
  if (scope === 'company' && !companyId) throw new AppError(ErrorCode.VALIDATION, '公司记忆必须指定公司');
  if (scope === 'project' && (!companyId || !projectId)) throw new AppError(ErrorCode.VALIDATION, '项目记忆必须指定公司和项目');
  if ((scope === 'personal' || scope === 'skill') && (companyId || projectId)) {
    throw new AppError(ErrorCode.VALIDATION, '个人或 Skill 记忆不能绑定公司/项目');
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

function escapeFtsQuery(query: string): string {
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
    });
    const entry = db.prepare('SELECT * FROM memory_entry WHERE source_candidate_id=?').get(candidate.id) as EntryRow | undefined;
    if (entry) copies.push(entryFromRow(entry));
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
