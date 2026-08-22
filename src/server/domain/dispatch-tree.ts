/**
 * 批次 H.2：派遣树聚合——项目（或某项目任务）的任务树 + 执行者雇佣元信息 + 进度。
 * 口径：统一按任务树（员工工作单/专家派遣单/蜂群工蜂/子任务一视同仁，2026-08-22 用工定调），
 * 雇佣身份只作标签：employee / specialist(借调) / bee。
 */
import type { DB } from '../db/client';
import { listTasks, type Task } from './task';

export interface DispatchActor {
  id: string;
  name: string;
  kind: 'employee' | 'specialist' | 'bee';
}

export interface DispatchTreeNode {
  id: string;
  seq: number;
  title: string;
  state: string;
  parentTaskId: string | null;
  swarmId: string | null;
  createdAt: string;
  completedAt: string | null;
  /** 工作时长（ms）：创建→完成/现在。 */
  durationMs: number;
  assignee: DispatchActor | null;
  dispatcher: { id: string; name: string } | null;
}

export interface DispatchTree {
  progress: { done: number; total: number };
  tasks: DispatchTreeNode[];
}

const ACTIVE = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'paused', 'blocked']);
const DONE = new Set(['completed', 'cancelled', 'failed']);

/** 按 parentTaskId 闭包 + swarmId 关联，从种子集扩到整棵任务树。 */
function expandTree(all: Task[], seedIds: Set<string>): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const t of all) {
    if (t.parentTaskId) byParent.set(t.parentTaskId, [...(byParent.get(t.parentTaskId) ?? []), t.id]);
  }
  const swarmIds = new Set(all.filter((t) => seedIds.has(t.id) && t.swarmId).map((t) => t.swarmId!));
  const result = new Set(seedIds);
  const queue = [...seedIds];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const child of byParent.get(cur) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
        const childTask = all.find((t) => t.id === child);
        if (childTask?.swarmId) swarmIds.add(childTask.swarmId);
      }
    }
  }
  // 蜂群节点：与种子同群的全部任务（汇总/蜂/子蜂）
  for (const t of all) {
    if (t.swarmId && swarmIds.has(t.swarmId)) result.add(t.id);
  }
  return result;
}

export function buildDispatchTree(db: DB, projectId: string, projectTaskId?: string): DispatchTree {
  const all = listTasks(db, projectId);
  let scope: Task[];
  if (projectTaskId) {
    const seed = new Set(all.filter((t) => t.projectTaskId === projectTaskId).map((t) => t.id));
    const ids = expandTree(all, seed);
    scope = all.filter((t) => ids.has(t.id));
  } else {
    scope = all;
  }

  // 执行者元信息批量取：agent 名 + 雇佣类型（蜂=swarm-worker 或群节点；专家池=借调；其余员工）
  const agentIds = new Set<string>();
  for (const t of scope) {
    if (t.assigneeAgentId) agentIds.add(t.assigneeAgentId);
    if (t.dispatcherAgentId) agentIds.add(t.dispatcherAgentId);
  }
  const agents = new Map<string, { name: string; role: string }>();
  for (const row of db
    .prepare(`SELECT id, name, role FROM agent_definition WHERE id IN (${[...agentIds].map(() => '?').join(',') || "''"})`)
    .all(...agentIds) as Array<{ id: string; name: string; role: string }>) {
    agents.set(row.id, { name: row.name, role: row.role });
  }
  const specialists = new Set(
    (db.prepare('SELECT agent_id FROM specialist_pool WHERE project_id=?').all(projectId) as Array<{ agent_id: string }>).map((r) => r.agent_id),
  );

  const actorOf = (id: string | null, task?: Task): DispatchActor | null => {
    if (!id) return null;
    const meta = agents.get(id);
    if (!meta) return { id, name: id, kind: 'employee' };
    const kind: DispatchActor['kind'] =
      meta.role === 'swarm-worker' || task?.swarmId ? 'bee' : specialists.has(id) ? 'specialist' : 'employee';
    return { id, name: meta.name, kind };
  };

  const now = Date.now();
  const nodes: DispatchTreeNode[] = scope.map((t) => {
    const assignee = actorOf(t.assigneeAgentId, t);
    const dispatcherMeta = t.dispatcherAgentId ? agents.get(t.dispatcherAgentId) : undefined;
    return {
      id: t.id,
      seq: t.seq,
      title: t.title,
      state: t.state,
      parentTaskId: t.parentTaskId,
      swarmId: t.swarmId,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
      durationMs: (t.completedAt ? new Date(t.completedAt).getTime() : now) - new Date(t.createdAt).getTime(),
      assignee,
      dispatcher: t.dispatcherAgentId && dispatcherMeta ? { id: t.dispatcherAgentId, name: dispatcherMeta.name } : null,
    };
  });

  const done = nodes.filter((n) => DONE.has(n.state)).length;
  const formal = nodes.filter((n) => ACTIVE.has(n.state) || DONE.has(n.state));
  return { progress: { done, total: formal.length }, tasks: nodes };
}
