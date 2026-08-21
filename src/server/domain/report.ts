/**
 * 强制复盘周期。
 *
 PRD：
 - 触发：时间 / 完成 Task 数 / 里程碑
 - 流程：停止领取 → 当前 Task 完成或安全保存 → review_paused → 第一负责人生成看板
 - 看板按根员工聚合若干结果，不逐条列 Task
 - 用户按摘要序号备注 → 第一负责人转修正 Task
 - 必须点"继续工作"才能恢复（review_paused → online）
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getProject } from './project';
import { transitionWorkbench } from './workbench';
import { listTasks } from './task';
import { listAgents } from './agent';
import { listThreads } from './thread';
import { summarizeAgentUsage } from './usage';
import type { ReportTrigger } from '../../shared/types';

export interface ReportSummary {
  id: string;
  projectId: string;
  cycleNo: number;
  triggerKind: ReportTrigger;
  summary: Record<string, unknown>;
  userNotes: Array<{ seq: number; note: string }>;
  state: 'open' | 'reviewing' | 'closed';
  openedAt: string;
  closedAt: string | null;
}

interface ReportRow {
  id: string;
  project_id: string;
  cycle_no: number;
  trigger_kind: string;
  summary_json: string;
  user_notes_json: string;
  state: string;
  opened_at: string;
  closed_at: string | null;
}

function fromRow(r: ReportRow): ReportSummary {
  return {
    id: r.id,
    projectId: r.project_id,
    cycleNo: r.cycle_no,
    triggerKind: r.trigger_kind as ReportTrigger,
    summary: JSON.parse(r.summary_json ?? '{}'),
    userNotes: JSON.parse(r.user_notes_json ?? '[]'),
    state: r.state as 'open' | 'reviewing' | 'closed',
    openedAt: r.opened_at,
    closedAt: r.closed_at,
  };
}

/**
 * 开启一个复盘周期：
 * 1. 把公司状态切到 review_paused（停止领取）。
 * 2. 第一负责人生成按根员工聚合的看板。
 * 3. 当前正在执行的 Task 完成或安全保存（此处仅停止领取，运行中的 Task 由引擎自然完成）。
 */
export function openReportCycle(
  db: DB,
  input: { projectId: string; triggerKind: ReportTrigger },
): ReportSummary {
  const project = getProject(db, input.projectId);
  // 切到 review_paused（停止领取新 Task）
  transitionWorkbench(db, 'review_paused');

  const cycleNo = nextCycleNo(db, input.projectId);
  const id = shortId('rc_');
  const now = nowIso();
  const summary = buildSummary(db, input.projectId);
  db.prepare(
    `INSERT INTO report_cycle (id, project_id, cycle_no, trigger_kind, summary_json, user_notes_json, state, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, '[]', 'open', ?, NULL)`,
  ).run(id, input.projectId, cycleNo, input.triggerKind, JSON.stringify(summary), now);
  return getReport(db, id);
}

function nextCycleNo(db: DB, projectId: string): number {
  const row = db.prepare('SELECT MAX(cycle_no) AS m FROM report_cycle WHERE project_id = ?').get(projectId) as { m: number | null } | undefined;
  return (row?.m ?? 0) + 1;
}

/**
 * 构建按根员工聚合的看板：
 - 每个根员工：完成 Task 数、主要成果摘要、阻塞、token/费用
 - 不逐条列 Task
 */
function buildSummary(db: DB, projectId: string): Record<string, unknown> {
  const project = getProject(db, projectId);
  // B5 观测修复：报表按 includeHidden 聚合——隐形中央岗（如验收员）的活动不从运营报表消失
  const agents = listAgents(db, { includeHidden: true });
  const tasks = listTasks(db, projectId);
  const byAgent = new Map<string, { completed: number; blocked: number; summaries: string[] }>();

  for (const t of tasks) {
    if (!t.assigneeAgentId) continue;
    const e = byAgent.get(t.assigneeAgentId) ?? { completed: 0, blocked: 0, summaries: [] };
    if (t.state === 'completed') {
      e.completed++;
      if (t.summary) e.summaries.push(t.summary);
    }
    if (t.state === 'blocked' || t.state === 'failed') e.blocked++;
    byAgent.set(t.assigneeAgentId, e);
  }

  const agents_ = agents.map((a) => {
    const e = byAgent.get(a.id) ?? { completed: 0, blocked: 0, summaries: [] };
    const usage = summarizeAgentUsage(db, projectId, a.id);
    // 镜像 task 归入根员工：因为镜像 thread 的 agent_id 就是根 agent_id
    return {
      agentId: a.id,
      name: a.name,
      role: a.role,
      completedTasks: e.completed,
      blocked: e.blocked,
      recentSummaries: e.summaries.slice(-3),
      tokens: usage.totalInputTokens + usage.totalOutputTokens,
      costUSD: usage.totalCostUSD,
    };
  });
  return {
    agents: agents_,
    totalTasks: tasks.length,
    completedTasksTotal: tasks.filter((task) => task.state === 'completed').length,
  };
}

export function getReport(db: DB, id: string): ReportSummary {
  const row = db.prepare('SELECT * FROM report_cycle WHERE id = ?').get(id) as ReportRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `report ${id} not found`);
  return fromRow(row);
}

export function listReports(db: DB, projectId: string): ReportSummary[] {
  const rows = db.prepare('SELECT * FROM report_cycle WHERE project_id = ? ORDER BY cycle_no DESC').all(projectId) as ReportRow[];
  return rows.map(fromRow);
}

/** 用户按摘要序号添加备注。 */
export function addReportNote(db: DB, reportId: string, note: string): ReportSummary {
  const cur = getReport(db, reportId);
  const notes = [...cur.userNotes, { seq: cur.userNotes.length + 1, note }];
  db.prepare('UPDATE report_cycle SET user_notes_json=?, state=\'reviewing\' WHERE id=?').run(
    JSON.stringify(notes),
    reportId,
  );
  return getReport(db, reportId);
}

/** 关闭复盘：把每条用户备注转成修正 Task 给第一负责人。 */
export function closeReport(db: DB, reportId: string, dispatchCorrection: (note: string, seq: number) => void): ReportSummary {
  const cur = getReport(db, reportId);
  // 把每条备注派发为修正 Task
  for (const n of cur.userNotes) {
    dispatchCorrection(n.note, n.seq);
  }
  db.prepare('UPDATE report_cycle SET state=\'closed\', closed_at=? WHERE id=?').run(nowIso(), reportId);
  return getReport(db, reportId);
}

/** 检查是否该触发强制复盘：基于完成 Task 数 / 时间间隔 / 里程碑。
 *
 * 优先级：task_count > time > milestone。
 * - task_count：完成数累计达到 lastBaseline + taskCountInterval。
 * - time：距离上一轮复盘 opened_at 超过 timeIntervalMs（无上一轮则从项目创建时间起算）。
 * - milestone：项目 settings.milestoneReviewAt 标记的里程碑时间已过且本轮未触发。
 */
export function shouldTriggerReport(
  db: DB,
  projectId: string,
  opts: {
    taskCountInterval?: number;
    timeIntervalMs?: number;
    now?: number;
    milestoneReviewAt?: string;
  },
): { trigger: boolean; kind: ReportTrigger | null } {
  const interval = opts.taskCountInterval ?? 20;
  const nowMs = opts.now ?? Date.now();
  const tasks = listTasks(db, projectId);
  const completed = tasks.filter((t) => t.state === 'completed').length;
  const reports = listReports(db, projectId);
  const open = reports.find((r) => r.state !== 'closed');
  if (open) return { trigger: false, kind: null };
  const lastReport = reports[0];
  const lastBaseline = Number(lastReport?.summary.completedTasksTotal ?? 0);

  // 1. task_count
  if (completed - lastBaseline >= interval) return { trigger: true, kind: 'task_count' };

  // 2. time：距上一轮复盘（或项目创建）超过 timeIntervalMs
  if (opts.timeIntervalMs && opts.timeIntervalMs > 0) {
    const reference = lastReport?.openedAt ?? getProject(db, projectId).createdAt;
    const refMs = new Date(reference).getTime();
    if (Number.isFinite(refMs) && nowMs - refMs >= opts.timeIntervalMs) {
      return { trigger: true, kind: 'time' };
    }
  }

  // 3. milestone：settings.milestoneReviewAt 或 opts.milestoneReviewAt 指定的里程碑时间已过
  const milestone = opts.milestoneReviewAt ?? String(getProject(db, projectId).settings.milestoneReviewAt ?? '');
  if (milestone) {
    const ms = new Date(milestone).getTime();
    // 仅在里程碑时间已到达、且上一轮复盘早于里程碑时触发
    if (Number.isFinite(ms) && nowMs >= ms) {
      const lastOpenedMs = lastReport ? new Date(lastReport.openedAt).getTime() : NaN;
      if (!Number.isFinite(lastOpenedMs) || lastOpenedMs < ms) {
        return { trigger: true, kind: 'milestone' };
      }
    }
  }

  return { trigger: false, kind: null };
}

void listThreads;
