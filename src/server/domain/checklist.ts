/**
 * 项目任务清单（批次三第二片）：用户手写逐项清单 → 一条一条执行，验收 PASS 自动解锁下一项。
 *
 * 机制（全部复用既有基建）：
 * - 条目任务 = 普通 runtime task，带 acceptanceCriteria（走既有自动验收链）+ inputProtocol.checklist 标记。
 * - 验收 PASS（acceptance-review 钩子）→ advanceChecklist 派下一条；全部完成 → done + 项目群播报。
 * - 验收 FAIL → 走既有返工链，不推进清单（天然门控：上一项不过，下一项不开工）。
 * - 负责人也可手动放行（API checklist/next），用于无验收场景或跳过有争议条目。
 * - 幂等：advance 只认「来源任务的 checklist.index === 当前 cursor」——重复 PASS/并发不跳条。
 */
import type { DB } from '../db/client';
import { nowIso } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';
import { createTask, getTask, type Task } from './task';
import { getProjectTask } from './project-task';
import { postSystemMessage } from './conversation';
import { getWorkbench } from './workbench';

export interface TaskChecklist {
  projectTaskId: string;
  items: string[];
  cursor: number;
  state: 'active' | 'done';
  createdAt: string;
  updatedAt: string;
}

interface Row { project_task_id: string; items_json: string; cursor: number; state: 'active' | 'done'; created_at: string; updated_at: string }

const fromRow = (r: Row): TaskChecklist => ({
  projectTaskId: r.project_task_id,
  items: JSON.parse(r.items_json ?? '[]') as string[],
  cursor: r.cursor,
  state: r.state,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getChecklist(db: DB, projectTaskId: string): TaskChecklist | null {
  const row = db.prepare('SELECT * FROM project_task_checklist WHERE project_task_id=?').get(projectTaskId) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** 条目任务默认执行人：项目第一负责人，缺省回退工作台第一负责人（与定时单同语义）。 */
function defaultAssignee(db: DB, projectId: string): string | undefined {
  const firstAgentId = (db.prepare('SELECT first_agent_id AS a FROM project WHERE id=?').get(projectId) as { a: string | null }).a;
  return firstAgentId ?? getWorkbench(db).firstAgentId ?? undefined;
}

function spawnChecklistItem(db: DB, checklist: TaskChecklist, projectId: string, assigneeAgentId?: string): Task {
  const item = checklist.items[checklist.cursor]!;
  return createTask(db, {
    projectId,
    projectTaskId: checklist.projectTaskId,
    title: `[清单 ${checklist.cursor + 1}/${checklist.items.length}] ${item}`,
    assigneeAgentId: assigneeAgentId ?? defaultAssignee(db, projectId),
    acceptanceCriteria: [{ id: 'chk', criterion: `完成清单条目：${item}` }],
    inputProtocol: { checklist: { index: checklist.cursor, total: checklist.items.length } },
    priority: 5,
  });
}

/** 创建清单（同项目任务已有清单则覆盖重建）并立即派发第 1 条。 */
export function createChecklist(db: DB, input: {
  projectId: string;
  projectTaskId: string;
  items: string[];
  assigneeAgentId?: string;
}): TaskChecklist {
  const projectTask = getProjectTask(db, input.projectTaskId);
  if (projectTask.projectId !== input.projectId) {
    throw new AppError(ErrorCode.VALIDATION, '清单必须挂在当前项目的项目任务下');
  }
  const items = input.items.map((s) => s.trim()).filter(Boolean);
  if (items.length === 0 || items.length > 50) {
    throw new AppError(ErrorCode.VALIDATION, '清单需要 1-50 个非空条目');
  }
  const now = nowIso();
  db.prepare(
    `INSERT INTO project_task_checklist (project_task_id, items_json, cursor, state, created_at, updated_at)
     VALUES (?, ?, 0, 'active', ?, ?)
     ON CONFLICT(project_task_id) DO UPDATE SET items_json=excluded.items_json, cursor=0, state='active', updated_at=excluded.updated_at`,
  ).run(input.projectTaskId, JSON.stringify(items), now, now);
  const checklist = getChecklist(db, input.projectTaskId)!;
  spawnChecklistItem(db, checklist, input.projectId, input.assigneeAgentId);
  return checklist;
}

/**
 * 推进清单：派下一条 / 收口。sourceTaskId 用于幂等校验（只认当前 cursor 对应的条目任务）；
 * 校验不符静默跳过——验收链可能对返工等衍生任务重复触发 PASS。
 */
export function advanceChecklist(db: DB, projectTaskId: string, sourceTaskId: string): { advanced: boolean; nextTaskId: string | null; done: boolean } {
  const checklist = getChecklist(db, projectTaskId);
  if (!checklist || checklist.state !== 'active') return { advanced: false, nextTaskId: null, done: false };
  const source = getTask(db, sourceTaskId);
  const marker = (source.inputProtocol ?? {}) as { checklist?: { index?: number } };
  if (marker.checklist?.index !== checklist.cursor) return { advanced: false, nextTaskId: null, done: false };

  const projectId = (db.prepare('SELECT project_id AS p FROM project_task WHERE id=?').get(projectTaskId) as { p: string }).p;
  const next = checklist.cursor + 1;
  if (next >= checklist.items.length) {
    db.prepare("UPDATE project_task_checklist SET state='done', updated_at=? WHERE project_task_id=?").run(nowIso(), projectTaskId);
    try {
      postSystemMessage(db, {
        scopeKind: 'project', scopeId: projectId, role: 'system', author: 'system',
        content: `[清单完成] 项目任务的 ${checklist.items.length} 项清单已全部通过验收。`,
      });
    } catch { /* 播报失败不阻断 */ }
    return { advanced: true, nextTaskId: null, done: true };
  }
  db.prepare('UPDATE project_task_checklist SET cursor=?, updated_at=? WHERE project_task_id=?').run(next, nowIso(), projectTaskId);
  const updated = getChecklist(db, projectTaskId)!;
  const task = spawnChecklistItem(db, updated, projectId);
  return { advanced: true, nextTaskId: task.id, done: false };
}
