/**
 * 任务阶段执行（蓝图工作流化批次④ M1，2026-08-29）：蓝图 stages 从图纸变调度。
 *
 * 执行模型=「单任务贯穿 + 引擎拦截推进」（详见 docs/superpowers/specs/blueprint-stage-workflow-engine.md §0.5）：
 * - ensureStageRuns：任务领取时从蓝图 stages 冻结快照建 task_stage_run 行（幂等；机制任务豁免）；
 * - stageContextSection：systemPrompt 的「阶段工作流」段——当前阶段 + 前序阶段产出摘要（MetaGPT 式交接）；
 * - advanceStageRun：完成漏斗拦截——当前阶段 passed → 下一阶段 running → 任务 running→queued 回队列
 *   并按 staffingPersonaIds[0] 改派（专家池常驻专家 > 保留现任）；末阶段完成返回 finished 走原收口。
 *
 * 兼容底线：无蓝图/无 stages/机制任务=零行为变化；本模块任何异常 fail-open 回落旧收口路径（引擎侧兜底）。
 * 失败/等待/审批暂停不动游标——恢复后重跑当前阶段（n8n 式 retry-from-failed-step）。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { log } from '../logger';
import type { Task } from './task';
import { getBlueprint } from './blueprint';
import { getAgent } from './agent';
import { coerceBlueprintStages, describeStages } from '../../shared/blueprint-stages';
import { findActiveSpecialistAgent } from './specialist-pool';
import { appendTaskEvent } from './task-event';

export type TaskStageStatus = 'pending' | 'running' | 'passed' | 'failed';

export interface TaskStageRun {
  id: string;
  taskId: string;
  projectId: string;
  blueprintId: string;
  stageId: string;
  step: number;
  label: string;
  description: string | null;
  dependsOn: string[] | null;
  staffingPersonaIds: string[] | null;
  status: TaskStageStatus;
  attempt: number;
  assigneeAgentId: string | null;
  summary: string | null;
  artifacts: Array<{ path: string; kind?: string; operation?: string }>;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StageRow {
  id: string; task_id: string; project_id: string; blueprint_id: string; stage_id: string;
  step: number; label: string; description: string | null; depends_on_json: string | null;
  staffing_persona_ids_json: string | null; status: string; attempt: number; assignee_agent_id: string | null;
  summary: string | null; artifacts_json: string; started_at: string | null; finished_at: string | null;
  created_at: string; updated_at: string;
}

function fromRow(row: StageRow): TaskStageRun {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    blueprintId: row.blueprint_id,
    stageId: row.stage_id,
    step: row.step,
    label: row.label,
    description: row.description,
    dependsOn: row.depends_on_json ? JSON.parse(row.depends_on_json) as string[] : null,
    staffingPersonaIds: row.staffing_persona_ids_json ? JSON.parse(row.staffing_persona_ids_json) as string[] : null,
    status: row.status as TaskStageStatus,
    attempt: row.attempt,
    assigneeAgentId: row.assignee_agent_id,
    summary: row.summary,
    artifacts: JSON.parse(row.artifacts_json ?? '[]') as TaskStageRun['artifacts'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listStageRuns(db: DB, taskId: string): TaskStageRun[] {
  const rows = db.prepare('SELECT * FROM task_stage_run WHERE task_id=? ORDER BY step ASC').all(taskId) as StageRow[];
  return rows.map(fromRow);
}

/** 机制任务豁免：讨论/建议发言、蜂群蜂（整群自有节拍）、外包承接不走阶段调度。（导出供测试直调） */
export function taskStageable(task: Task): boolean {
  if (task.isDiscussion || task.isSuggestion) return false;
  if (task.swarmId) return false;
  if (task.outsourcingContractId) return false;
  const blueprintId = (task.inputProtocol as Record<string, unknown>)?.blueprintMatched;
  return typeof blueprintId === 'string' && blueprintId.length > 0;
}

/**
 * 领取时确保阶段行（幂等）：穿蓝图且有 stages 的任务，从蓝图**冻结快照**建行并把首阶段置 running。
 * 返回全部阶段行；无蓝图/无 stages/豁免任务返回 null（零行为变化）。已存在行不重建——
 * 跑动中蓝图被改/回滚不影响本任务（spec §6 回滚语义）。
 */
export function ensureStageRuns(db: DB, task: Task): TaskStageRun[] | null {
  if (!taskStageable(task)) return null;
  const existing = listStageRuns(db, task.id);
  if (existing.length > 0) return existing;

  const blueprintId = (task.inputProtocol as Record<string, unknown>).blueprintMatched as string;
  let blueprint;
  try {
    blueprint = getBlueprint(db, blueprintId);
  } catch {
    return null; // 蓝图已删：回落无阶段行为
  }
  const stages = coerceBlueprintStages(blueprint.stages);
  if (stages.length === 0) return null;

  const now = nowIso();
  db.transaction(() => {
    for (const stage of stages) {
      db.prepare(
        `INSERT INTO task_stage_run (id, task_id, project_id, blueprint_id, stage_id, step, label, description,
           depends_on_json, staffing_persona_ids_json, status, attempt, assignee_agent_id, artifacts_json,
           started_at, finished_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '[]', ?, NULL, ?, ?)`,
      ).run(
        shortId('tsr_'), task.id, task.projectId, blueprintId, stage.id, stage.step, stage.label,
        stage.description ?? null,
        stage.dependsOn ? JSON.stringify(stage.dependsOn) : null,
        stage.staffingPersonaIds ? JSON.stringify(stage.staffingPersonaIds) : null,
        stage.step === 1 ? 'running' : 'pending',
        stage.step === 1 ? task.assigneeAgentId ?? null : null,
        stage.step === 1 ? now : null,
        now, now,
      );
    }
    appendTaskEvent(db, task.id, 'stage_plan_frozen', {
      blueprintId,
      stages: describeStages(stages),
      note: '按蓝图阶段工作流推进：本任务运行期内蓝图变更不影响已冻结的阶段计划',
    });
  })();
  return listStageRuns(db, task.id);
}

/** 当前执行中的阶段（无行/无 running 返回 null）。 */
export function currentStageRun(db: DB, taskId: string): TaskStageRun | null {
  const row = db.prepare(
    "SELECT * FROM task_stage_run WHERE task_id=? AND status='running' ORDER BY step ASC LIMIT 1",
  ).get(taskId) as StageRow | undefined;
  return row ? fromRow(row) : null;
}

function stageAssigneeName(db: DB, agentId: string | null): string {
  if (!agentId) return '现任执行者';
  try {
    return getAgent(db, agentId).name;
  } catch {
    return '执行者';
  }
}

/**
 * systemPrompt 的「阶段工作流」段：全链路概览 + 当前阶段 k/N + 前序产出摘要 + 只做本阶段指令。
 * 无阶段任务返回 null。
 */
export function stageContextSection(db: DB, taskId: string): string | null {
  const runs = listStageRuns(db, taskId);
  if (runs.length === 0) return null;
  const current = runs.find((r) => r.status === 'running') ?? runs.find((r) => r.status === 'pending');
  if (!current) return null;
  const total = runs.length;
  const done = runs.filter((r) => r.status === 'passed');
  const upcoming = runs.filter((r) => r.step > current.step);

  const lines: string[] = [
    '# 阶段工作流（本任务按蓝图流水线推进）',
    `这套打法共 ${total} 个阶段：${describeStages(runs.map((r) => ({ id: r.stageId, step: r.step, label: r.label })))}。`,
    `## 当前阶段 ${current.step}/${total}：${current.label}`,
  ];
  if (current.description) lines.push(current.description);
  const stagePersonaIds = current.staffingPersonaIds ?? [];
  if (stagePersonaIds.length > 0) {
    lines.push(`本阶段主责成员（人设）：${stagePersonaIds.join('、')}；其余班底以协作身份在场。`);
  }
  if (done.length > 0) {
    lines.push('## 前序阶段产出（交接输入，不要重做）');
    for (const prev of done) {
      const files = prev.artifacts.map((a) => a.path).filter(Boolean).slice(0, 10).join('、');
      lines.push(`- 阶段 ${prev.step}/${total}「${prev.label}」：${prev.summary?.slice(0, 300) ?? '（无摘要）'}${files ? `（产出：${files}）` : ''}`);
    }
  }
  if (upcoming.length > 0) {
    lines.push(`## 后续阶段（本次不做）：${upcoming.map((r) => r.label).join(' → ')}`);
  }
  lines.push('执行纪律：本阶段只做本阶段的活——完成本阶段产出并汇报后即可结束本轮（系统会调度下一阶段与下一位执行者），不要越阶段代劳。');
  return lines.join('\n');
}

export interface StageAdvanceOutcome {
  /** true=已推进到下一阶段（任务已回 queued，引擎不得再走 completeTask）。 */
  advanced: boolean;
  /** true=全部阶段完成（引擎正常走 completeTask 收口）。 */
  finished: boolean;
  /** 现场播报文案（advanced 时非空）。 */
  milestone: string;
}

/**
 * 完成漏斗拦截（引擎在 completeTask 前调用；fail-open：任何异常记日志返回 null 回落旧收口）：
 * - 当前 running 阶段标 passed（summary/artifacts/attempt 落行）；
 * - 有下一阶段：置 running（attempt=1）→ 解析改派（阶段 staffingPersonaIds[0] 的项目常驻专家 > 保留现任）
 *   → 任务专用迁移 running→queued（清租约、assignee 换人、inputProtocol.stageCursor 前进、事件留痕）；
 * - 无下一阶段：末阶段已标 passed，返回 finished=true 交引擎原路收口。
 */
export function advanceStageRun(
  db: DB,
  taskId: string,
  result: { summary?: string; artifacts?: TaskStageRun['artifacts'] },
): StageAdvanceOutcome | null {
  try {
    return advanceStageRunInner(db, taskId, result);
  } catch (e) {
    log.error('stage advance failed; falling back to plain completion', {
      taskId, err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

function advanceStageRunInner(
  db: DB,
  taskId: string,
  result: { summary?: string; artifacts?: TaskStageRun['artifacts'] },
): StageAdvanceOutcome | null {
  const runs = listStageRuns(db, taskId);
  if (runs.length === 0) return null;
  const current = runs.find((r) => r.status === 'running');
  if (!current) return null;

  const now = nowIso();
  const next = runs.find((r) => r.step > current.step && r.status === 'pending') ?? null;
  let nextAssignee: string | null = null;

  db.transaction(() => {
    db.prepare(
      `UPDATE task_stage_run SET status='passed', summary=?, artifacts_json=?, finished_at=?, updated_at=? WHERE id=?`,
    ).run(
      (result.summary ?? '').slice(0, 2000) || '（阶段完成）',
      JSON.stringify(result.artifacts ?? []),
      now, now, current.id,
    );

    if (!next) {
      appendTaskEvent(db, taskId, 'stage_completed', {
        step: current.step, total: runs.length, label: current.label, finished: true,
      });
      return;
    }

    // 阶段改派：下一阶段主责人设 → 项目常驻专家；解析不到保留现任（改派失败不阻断推进）。
    const nextPersonaId = next.staffingPersonaIds?.[0] ?? null;
    const taskRow = db.prepare('SELECT assignee_agent_id, input_protocol_json FROM task WHERE id=?').get(taskId) as
      { assignee_agent_id: string | null; input_protocol_json: string } | undefined;
    const currentAssignee = taskRow?.assignee_agent_id ?? null;
    nextAssignee = currentAssignee;
    if (nextPersonaId) {
      const specialist = findActiveSpecialistAgent(db, current.projectId, nextPersonaId);
      if (specialist) nextAssignee = specialist;
    }

    db.prepare(
      `UPDATE task_stage_run SET status='running', attempt=attempt+1, assignee_agent_id=?, started_at=?, updated_at=? WHERE id=?`,
    ).run(nextAssignee, now, now, next.id);

    // 任务专用迁移 running→queued（阶段推进，非失败非暂停）：清租约回队列，改派执行者，游标前进。
    const proto = JSON.parse(taskRow?.input_protocol_json ?? '{}') as Record<string, unknown>;
    proto.stageCursor = next.step;
    db.prepare(
      `UPDATE task SET state='queued', assignee_agent_id=?, assignee_thread_id=NULL,
         lease_owner_thread_id=NULL, lease_expires_at=NULL, input_protocol_json=?, updated_at=? WHERE id=?`,
    ).run(nextAssignee, JSON.stringify(proto), now, taskId);

    appendTaskEvent(db, taskId, 'stage_advanced', {
      from: { step: current.step, label: current.label },
      to: { step: next.step, label: next.label },
      total: runs.length,
      nextAssigneeAgentId: nextAssignee,
      note: `阶段 ${current.step}/${runs.length}「${current.label}」完成，进入阶段 ${next.step}/${runs.length}「${next.label}」`,
    });
  })();

  if (!next) return { advanced: false, finished: true, milestone: '' };
  return {
    advanced: true,
    finished: false,
    milestone: `✅ 阶段 ${current.step}/${runs.length} 完成：${current.label} → 进入阶段 ${next.step}/${runs.length}：${next.label}（${stageAssigneeName(db, nextAssignee)} 接手）`,
  };
}
