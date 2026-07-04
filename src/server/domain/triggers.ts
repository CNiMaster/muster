/**
 * 触发器：事件触发 + 定时触发。
 *
 - 章节完成事件 → 自动派发人物/情节/时间线/伏笔维护 Task（若存在对应责任岗位）
 - 定时触发 → 派发遗漏检查、连续性检查、长期一致性检查 Task
 - 用户纠正 → 派发修正 Task
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { getProject } from './project';
import { listAgents } from './agent';
import { createTask } from './task';
import type { ArtifactChange } from '../../shared/types';

/** 注册一个事件触发器（持久化）。 */
export function registerEventTrigger(
  db: DB,
  input: { projectId: string; eventName: string; template: Record<string, unknown> },
): { id: string } {
  const id = shortId('tr_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO trigger (id, project_id, kind, event_name, template_json, enabled, created_at, updated_at)
     VALUES (?, ?, 'event', ?, ?, 1, ?, ?)`,
  ).run(id, input.projectId, input.eventName, JSON.stringify(input.template), now, now);
  return { id };
}

/** 注册一个定时触发器。 */
export function registerScheduleTrigger(
  db: DB,
  input: { projectId: string; intervalMs: number; template: Record<string, unknown> },
): { id: string } {
  const id = shortId('tr_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO trigger (id, project_id, kind, interval_ms, template_json, enabled, created_at, updated_at)
     VALUES (?, ?, 'schedule', ?, ?, 1, ?, ?)`,
  ).run(id, input.projectId, input.intervalMs, JSON.stringify(input.template), now, now);
  return { id };
}

export interface ChapterCompletedEvent {
  projectId: string;
  chapterPath: string;
  chapterSeq: number;
  summary: string;
  artifacts: ArtifactChange[];
}

/**
 * 章节完成事件处理：
 * - 找到项目的 character/plot/timeline/foreshadowing 责任员工
 * - 给每个相关岗位派发一个维护 Task
 * - 模板：{ trigger: 'chapter_completed', chapter, summary }
 */
export function handleChapterCompleted(db: DB, ev: ChapterCompletedEvent): string[] {
  const project = getProject(db, ev.projectId);
  const agents = listAgents(db, project.companyId);
  const dispatched: string[] = [];

  const byRole = (role: string): string | undefined => agents.find((a) => a.role === role)?.id;

  const targets: Array<{ role: string; title: string }> = [
    { role: 'character', title: `[事件] 维护人物档案（第${ev.chapterSeq}章）` },
    { role: 'plot', title: `[事件] 维护剧情进度与伏笔（第${ev.chapterSeq}章）` },
  ];

  for (const t of targets) {
    const agentId = byRole(t.role);
    if (!agentId) continue;
    const task = createTask(db, {
      projectId: ev.projectId,
      assigneeAgentId: agentId,
      dispatcherAgentId: project.firstAgentId ?? undefined,
      title: t.title,
      inputProtocol: {
        trigger: 'chapter_completed',
        chapter: ev.chapterPath,
        chapterSeq: ev.chapterSeq,
        summary: ev.summary,
        artifacts: ev.artifacts,
      },
      priority: 6,
    });
    dispatched.push(task.id);
  }

  return dispatched;
}

/** 派发定时一致性检查 Task（可被 scheduler 调用）。 */
export function dispatchConsistencyCheck(db: DB, projectId: string, checkKind: 'omission' | 'continuity' | 'long_term'): string | null {
  const project = getProject(db, projectId);
  const inspector = listAgents(db, project.companyId).find((a) => a.isInspector);
  const target = inspector?.id ?? project.firstAgentId;
  if (!target) return null;
  const labels: Record<typeof checkKind, string> = {
    omission: '[定时] 遗漏检查',
    continuity: '[定时] 连续性检查',
    long_term: '[定时] 长期一致性检查',
  };
  const task = createTask(db, {
    projectId,
    assigneeAgentId: target,
    title: labels[checkKind],
    inputProtocol: { trigger: 'schedule', check: checkKind },
    priority: 4,
  });
  return task.id;
}

/** 派发用户纠正 → 修正 Task（给第一负责人）。 */
export function dispatchCorrectionTask(
  db: DB,
  projectId: string,
  correction: { note: string; sourceCycleSeq?: number },
): string | null {
  const project = getProject(db, projectId);
  if (!project.firstAgentId) return null;
  const task = createTask(db, {
    projectId,
    assigneeAgentId: project.firstAgentId,
    title: `[纠正] ${correction.note.slice(0, 40)}`,
    inputProtocol: {
      trigger: 'user_correction',
      note: correction.note,
      sourceCycleSeq: correction.sourceCycleSeq,
    },
    priority: 8,
  });
  return task.id;
}
