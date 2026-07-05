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

export type ThreadKind = 'primary' | 'mirror';
export type ThreadState = 'idle' | 'running' | 'waiting' | 'paused' | 'failed';

export interface ProjectAgentThread {
  id: string;
  projectId: string;
  agentId: string;
  kind: ThreadKind;
  rootThreadId: string | null;
  claudeSessionId: string | null;
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
export function createMirror(db: DB, projectId: string, agentId: string): ProjectAgentThread {
  getProject(db, projectId);
  getAgent(db, agentId);
  const root = ensurePrimaryThread(db, projectId, agentId);
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
       WHERE c.state = 'online'
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

/** 删除镜像（不可删 primary，删 primary 走项目删除级联）。 */
export function removeMirror(db: DB, id: string): void {
  const t = getThread(db, id);
  if (t.kind !== 'mirror') {
    throw new AppError(ErrorCode.CONFLICT, '不能删除 primary thread');
  }
  db.prepare('DELETE FROM project_agent_thread WHERE id = ?').run(id);
}
