/**
 * Project Agent Thread：员工在项目中的运行线程。
 *
 - 同一员工在不同项目拥有不同 thread，互不串线。
 - 镜像 thread（kind='mirror'）属于同一项目同一员工，root_thread_id 指向其根线程。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getProject } from './project';
import { getAgent, listAgents } from './agent';
import { flushThreadMemory } from './memory';

export type ThreadKind = 'primary' | 'mirror';
export type ThreadState = 'idle' | 'running' | 'waiting' | 'paused' | 'failed';

export interface ProjectAgentThread {
  id: string;
  projectId: string;
  agentId: string;
  kind: ThreadKind;
  rootThreadId: string | null;
  claudeSessionId: string | null;
  previousSessionId: string | null;
  context: Record<string, unknown>;
  state: ThreadState;
  createdAt: string;
  updatedAt: string;
}

interface ThreadRow {
  id: string;
  project_id: string;
  agent_id: string;
  kind: ThreadKind;
  root_thread_id: string | null;
  claude_session_id: string | null;
  previous_session_id: string | null;
  context_json: string;
  state: string;
  created_at: string;
  updated_at: string;
}

function fromRow(r: ThreadRow): ProjectAgentThread {
  return {
    id: r.id,
    projectId: r.project_id,
    agentId: r.agent_id,
    kind: r.kind,
    rootThreadId: r.root_thread_id,
    claudeSessionId: r.claude_session_id,
    previousSessionId: r.previous_session_id ?? null,
    context: JSON.parse(r.context_json ?? '{}'),
    state: r.state as ThreadState,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 让员工进入项目（创建 primary thread）。幂等：已存在则返回现有。 */
export function ensurePrimaryThread(db: DB, projectId: string, agentId: string): ProjectAgentThread {
  getProject(db, projectId);
  getAgent(db, agentId);
  const existing = db
    .prepare(`SELECT * FROM project_agent_thread WHERE project_id = ? AND agent_id = ? AND kind = 'primary'`)
    .get(projectId, agentId) as ThreadRow | undefined;
  if (existing) return fromRow(existing);

  const id = shortId('th_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO project_agent_thread (id, project_id, agent_id, kind, root_thread_id, claude_session_id, context_json, state, created_at, updated_at)
     VALUES (?, ?, ?, 'primary', NULL, NULL, '{}', 'idle', ?, ?)`,
  ).run(id, projectId, agentId, now, now);
  return getThread(db, id);
}

/** 创建镜像 thread（同一项目同一员工的临时并行）。 */
export function createMirror(db: DB, projectId: string, agentId: string, options?: { reuseIdle?: boolean }): ProjectAgentThread {
  const project = getProject(db, projectId);
  const agent = getAgent(db, agentId);
  if (agent.companyId !== project.companyId) {
    throw new AppError(ErrorCode.VALIDATION, '镜像员工必须属于项目所在公司');
  }
  const root = ensurePrimaryThread(db, projectId, agentId);
  // 讨论分身上限（仅 reuseIdle=true 时）：同一员工同一项目复用空闲 mirror，防止失控
  if (options?.reuseIdle) {
    const existing = listMirrorsOfRoot(db, root.id).filter((m) => m.state === 'idle');
    if (existing.length >= 1) return existing[0];
  }
  const id = shortId('th_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO project_agent_thread (id, project_id, agent_id, kind, root_thread_id, claude_session_id, context_json, state, created_at, updated_at)
     VALUES (?, ?, ?, 'mirror', ?, NULL, '{}', 'idle', ?, ?)`,
  ).run(id, projectId, agentId, root.id, now, now);
  return getThread(db, id);
}

export function getThread(db: DB, id: string): ProjectAgentThread {
  const row = db.prepare('SELECT * FROM project_agent_thread WHERE id = ?').get(id) as ThreadRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `thread ${id} not found`);
  return fromRow(row);
}

export function listThreads(db: DB, projectId: string): ProjectAgentThread[] {
  const rows = db.prepare('SELECT * FROM project_agent_thread WHERE project_id = ? ORDER BY created_at').all(projectId) as ThreadRow[];
  return rows.map(fromRow);
}

/** 为项目中的全部正式员工幂等建立 primary thread。 */
export function ensureProjectThreads(db: DB, projectId: string): ProjectAgentThread[] {
  const project = getProject(db, projectId);
  for (const agent of listAgents(db, project.companyId)) {
    ensurePrimaryThread(db, projectId, agent.id);
  }
  return listThreads(db, projectId).filter((thread) => thread.kind === 'primary');
}

export function listMirrorsOfRoot(db: DB, rootThreadId: string): ProjectAgentThread[] {
  const rows = db.prepare('SELECT * FROM project_agent_thread WHERE root_thread_id = ?').all(rootThreadId) as ThreadRow[];
  return rows.map(fromRow);
}

/** 跨项目列出 online 公司下所有活跃线程（用于引擎轮询）。 */
export function listOnlineThreads(db: DB): ProjectAgentThread[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM project_agent_thread t
       JOIN project p ON p.id = t.project_id
       JOIN company c ON c.id = p.company_id
       JOIN agent_definition a ON a.id = t.agent_id
       WHERE c.state = 'online' AND a.availability_state = 'online'
       ORDER BY t.created_at`,
    )
    .all() as ThreadRow[];
  return rows.map(fromRow);
}

export function updateThreadState(db: DB, id: string, state: ThreadState): ProjectAgentThread {
  db.prepare('UPDATE project_agent_thread SET state=?, updated_at=? WHERE id=?').run(state, nowIso(), id);
  return getThread(db, id);
}

export function setClaudeSession(db: DB, id: string, sessionId: string): ProjectAgentThread {
  db.prepare('UPDATE project_agent_thread SET claude_session_id=?, updated_at=? WHERE id=?').run(sessionId, nowIso(), id);
  return getThread(db, id);
}

/**
 会话压缩/轮换（PRD Phase 3.6）。
 - 每次 Task 执行后调用 incrementExecCount。
 - exec_count 达到阈值时返回 shouldCompact，提示引擎执行压缩（生成摘要 + 清空 session）。
 - 压缩由 clearSessionForCompaction 完成：清空 session id，写入摘要，重置 exec_count。
 - 时间轮换：距上次开新 session 超过 MUSTER_SESSION_ROTATION_HOURS（默认 24）时返回 shouldRotate，
   引擎清空 session（下次开新 session）但不重置 exec_count，区别于压缩。
 */
export function incrementExecCount(db: DB, id: string): { count: number; shouldCompact: boolean; shouldRotate: boolean } {
  const now = new Date();
  db.prepare('UPDATE project_agent_thread SET exec_count = exec_count + 1, updated_at=? WHERE id=?').run(now.toISOString(), id);
  const row = db.prepare('SELECT exec_count, last_rotation_at FROM project_agent_thread WHERE id=?').get(id) as
    | { exec_count: number; last_rotation_at: string | null }
    | undefined;
  const count = row?.exec_count ?? 0;
  const threshold = Number(process.env.MUSTER_SESSION_COMPACT_THRESHOLD ?? 30);
  const shouldCompact = count >= threshold && threshold > 0;
  // 时间轮换：默认 24 小时；设为 0 关闭
  const rotationHours = Number(process.env.MUSTER_SESSION_ROTATION_HOURS ?? 24);
  let shouldRotate = false;
  if (rotationHours > 0) {
    const lastRot = row?.last_rotation_at ? new Date(row.last_rotation_at).getTime() : NaN;
    // 无记录或非有限时间视为需要轮换的边界（不在此处触发，避免每次都 rotate）
    if (Number.isFinite(lastRot) && now.getTime() - lastRot >= rotationHours * 3600_000) {
      shouldRotate = true;
    }
  }
  return { count, shouldCompact, shouldRotate };
}

export function clearSessionForCompaction(db: DB, id: string, summary: string): void {
  db.prepare(
    `UPDATE project_agent_thread
     SET previous_session_id=claude_session_id, claude_session_id=NULL, exec_count=0,
       last_compaction_at=?, compaction_summary=?, updated_at=?
     WHERE id=?`,
  ).run(nowIso(), summary, nowIso(), id);
}

export function compactThreadWithMemory(db: DB, id: string, input: {
  summary: string;
  memoryContent: string;
  sourceTaskId?: string;
  flush?: () => void;
}): void {
  getThread(db, id);
  if (input.flush) input.flush();
  else flushThreadMemory(db, { threadId: id, content: input.memoryContent, sourceTaskId: input.sourceTaskId });
  clearSessionForCompaction(db, id, input.summary);
}

/**
 时间轮换：清空 session（下次开新 session）并刷新 last_rotation_at。
 与压缩的区别：不重置 exec_count、不写 compaction_summary。
 */
export function rotateSession(db: DB, id: string): void {
  db.prepare(
    `UPDATE project_agent_thread
     SET claude_session_id=NULL, last_rotation_at=?, updated_at=?
     WHERE id=?`,
  ).run(nowIso(), nowIso(), id);
}

export function getCompactionSummary(db: DB, id: string): string | null {
  const row = db.prepare('SELECT compaction_summary FROM project_agent_thread WHERE id=?').get(id) as
    | { compaction_summary: string | null }
    | undefined;
  return row?.compaction_summary ?? null;
}

/** 删除镜像（不可删 primary，删 primary 走项目删除级联）。 */
export function removeMirror(db: DB, id: string): void {
  const t = getThread(db, id);
  if (t.kind !== 'mirror') {
    throw new AppError(ErrorCode.CONFLICT, '不能删除 primary thread');
  }
  const activeTask = db.prepare(
    `SELECT 1 FROM task
     WHERE lease_owner_thread_id=? AND state IN ('claimed','running') LIMIT 1`,
  ).get(id);
  if (t.state === 'running' || activeTask) {
    throw new AppError(ErrorCode.CONFLICT, '镜像正在执行 Task，必须完成当前 Task 后再注销');
  }
  db.prepare('DELETE FROM project_agent_thread WHERE id = ?').run(id);
}

/**
 项目结束时安全释放所有 mirror（PRD Phase 5.4）。
 - 仅删除 idle 且无活跃 Task 的 mirror，保留 primary。
 - running / claimed 的 mirror 留到下一轮（避免丢工作）。
 - 返回被释放的 thread id 列表，便于审计。
 */
export function releaseProjectMirrors(db: DB, projectId: string): string[] {
  getProject(db, projectId);
  const mirrors = db
    .prepare("SELECT id FROM project_agent_thread WHERE project_id=? AND kind='mirror'")
    .all(projectId) as Array<{ id: string }>;
  const released: string[] = [];
  for (const m of mirrors) {
    const activeTask = db
      .prepare(
        `SELECT 1 FROM task
         WHERE lease_owner_thread_id=? AND state IN ('claimed','running') LIMIT 1`,
      )
      .get(m.id);
    if (activeTask) continue; // 等下一轮
    db.prepare('DELETE FROM project_agent_thread WHERE id = ?').run(m.id);
    released.push(m.id);
  }
  return released;
}
