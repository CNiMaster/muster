/**
 * 任务阶段执行域（蓝图工作流化批次④ M1，2026-08-29）：
 * - 豁免矩阵：讨论/建议/蜂群蜂/外包承接/无蓝图不走阶段调度
 * - ensureStageRuns：冻结快照建行（蓝图后改不影响已建行）+ 幂等 + 无蓝图返回 null
 * - advanceStageRun：中段推进（passed 产出落行+下一 running+任务回 queued+改派）；末阶段 finished 不回队；
 *   轮转走专家池常驻专家；无阶段行/无 running 返回 null（fail-open 语义）
 * - stageContextSection：当前阶段+前序产出交接+纪律行
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb, createNovelCompany } from '../integration/setup';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, claimNextTask, markRunning } from '../../src/server/domain/task';
import { evolveBlueprint, publishBlueprintDebugResult } from '../../src/server/domain/blueprint';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { listPersonas } from '../../src/server/domain/persona-library';
import { createProjectSpecialist } from '../../src/server/domain/specialist-pool';
import { listTaskEvents } from '../../src/server/domain/task-event';
import {
  taskStageable, ensureStageRuns, listStageRuns, currentStageRun,
  stageContextSection, advanceStageRun,
} from '../../src/server/domain/task-stage';
import type { Task } from '../../src/server/domain/task';

let db: DB;
let workbenchId: string;
let projectId: string;
let leadAgentId: string;
let blueprintId: string;
let personaAId: string;
let personaBId: string;

const baseTask = { isDiscussion: 0, isSuggestion: 0, swarmId: null, outsourcingContractId: null } as Partial<Task>;

beforeEach(() => {
  const tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  workbenchId = r.company.id;
  leadAgentId = r.agents.lead.id;
  const project = createProject(db, { companyId: workbenchId, name: '阶段流水线项目', rootDir: '/tmp/task-stage', firstAgentId: leadAgentId, initialState: 'active' });
  projectId = project.id;

  const [pa, pb] = listPersonas();
  personaAId = pa.id;
  personaBId = pb.id;
  const bp = evolveBlueprint(db, {
    companyId: workbenchId, projectId, taskTitle: '阶段流水线测试_xyz',
    personaId: personaAId, personaName: pa.name, win: true,
  })!;
  blueprintId = bp.id;
});

function stageableTask(input: Partial<Task>): Task {
  return { ...baseTask, ...input, inputProtocol: { blueprintMatched: blueprintId } } as unknown as Task;
}

function seedStages(stages: Array<{ id: string; step: number; label: string; description?: string; staffingPersonaIds?: string[] }>): void {
  publishBlueprintDebugResult(db, {
    blueprintId,
    staffing: [
      { personaId: personaAId, personaName: '主责A' },
      { personaId: personaBId, personaName: '协作B' },
    ],
    stages,
    summary: '测试布景：两阶段流水线',
  });
}

/** 走真实穿戴路径建任务（blueprintMeta.blueprintMatched 留痕），领取置 running。
 * 队列里可能有更早入队的规划类任务（首agent可领），循环领取直到抢到本任务。 */
function createAndRunStageableTask(): string {
  const task = createTask(db, { projectId, title: '按流水线走一遍', blueprintId });
  const leadThread = ensurePrimaryThread(db, projectId, leadAgentId);
  let claimedMine = false;
  for (let i = 0; i < 10 && !claimedMine; i++) {
    const claimed = claimNextTask(db, leadThread.id, leadAgentId);
    claimedMine = claimed?.task.id === task.id;
  }
  expect(claimedMine).toBe(true);
  markRunning(db, task.id);
  return task.id;
}

describe('豁免矩阵 taskStageable', () => {
  it('讨论/建议/蜂群蜂/外包承接/无蓝图均不走阶段调度', () => {
    expect(taskStageable(stageableTask({}))).toBe(true);
    expect(taskStageable(stageableTask({ isDiscussion: 1 }))).toBe(false);
    expect(taskStageable(stageableTask({ isSuggestion: 1 }))).toBe(false);
    expect(taskStageable(stageableTask({ swarmId: 'sw_1' }))).toBe(false);
    expect(taskStageable(stageableTask({ outsourcingContractId: 'oc_1' }))).toBe(false);
    expect(taskStageable({ ...baseTask, inputProtocol: {} } as unknown as Task)).toBe(false);
    // 谓词只看形状；蓝图存在性由 ensureStageRuns 兜（见下：蓝图已删返回 null）
  });
});

describe('ensureStageRuns', () => {
  it('冻结快照建行：首阶段 running、其余 pending；蓝图此后变更不影响已建行；幂等', () => {
    seedStages([
      { id: 's1', step: 1, label: '梳理', description: '对齐目标' },
      { id: 's2', step: 2, label: '成稿' },
    ]);
    const taskId = createAndRunStageableTask();
    const before = getTask(db, taskId);

    const rows = ensureStageRuns(db, before);
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'running', label: '梳理', step: 1 });
    expect(rows[1]).toMatchObject({ status: 'pending', label: '成稿' });
    expect(listTaskEvents(db, taskId).some((e) => e.kind === 'stage_plan_frozen')).toBe(true);

    // 蓝图阶段被改（画布/AI 路径）不影响已冻结行
    publishBlueprintDebugResult(db, {
      blueprintId,
      stages: [{ id: 'x9', step: 1, label: '被改掉的阶段' }],
      summary: '跑动中改蓝图',
    });
    const again = ensureStageRuns(db, getTask(db, taskId));
    expect(again!.map((r) => r.stageId)).toEqual(['s1', 's2']); // 幂等不重建
  });

  it('无蓝图任务返回 null（零行为变化）；蓝图已删同样回落 null', () => {
    const task = createTask(db, { projectId, title: '普通任务' });
    expect(ensureStageRuns(db, getTask(db, task.id))).toBeNull();

    seedStages([{ id: 's1', step: 1, label: '梳理' }]);
    const staged = createTask(db, { projectId, title: '蓝图将被删的任务', blueprintId });
    db.prepare('DELETE FROM blueprint WHERE id=?').run(blueprintId);
    expect(ensureStageRuns(db, getTask(db, staged.id))).toBeNull();
  });
});

describe('advanceStageRun', () => {
  it('中段推进：当前 passed 落产出、下一 running、任务回 queued、事件留痕', () => {
    seedStages([
      { id: 's1', step: 1, label: '梳理' },
      { id: 's2', step: 2, label: '成稿' },
    ]);
    const taskId = createAndRunStageableTask();
    ensureStageRuns(db, getTask(db, taskId));

    const out = advanceStageRun(db, taskId, {
      summary: '梳理完成：定了三步走',
      artifacts: [{ path: 'plan.md', kind: 'markdown', operation: 'create' }],
    });
    expect(out?.advanced).toBe(true);
    expect(out?.milestone).toContain('阶段 1/2');
    expect(out?.milestone).toContain('成稿');

    const runs = listStageRuns(db, taskId);
    expect(runs[0]).toMatchObject({ status: 'passed', summary: '梳理完成：定了三步走' });
    expect(runs[0].artifacts).toEqual([{ path: 'plan.md', kind: 'markdown', operation: 'create' }]);
    expect(runs[1]).toMatchObject({ status: 'running', attempt: 1 });

    const task = getTask(db, taskId);
    expect(task.state).toBe('queued'); // 阶段推进专用迁移，非失败非暂停
    expect(task.assigneeAgentId).toBe(leadAgentId); // 无阶段绑定 → 保留现任
    expect((task.inputProtocol as Record<string, unknown>).stageCursor).toBe(2);
    expect(listTaskEvents(db, taskId).some((e) => e.kind === 'stage_advanced')).toBe(true);
  });

  it('阶段改派：下一阶段绑定人设且有常驻专家 → 换专家接手', () => {
    seedStages([
      { id: 's1', step: 1, label: '梳理' },
      { id: 's2', step: 2, label: '成稿', staffingPersonaIds: [personaBId] },
    ]);
    const spec = createProjectSpecialist(db, { projectId, specialty: '成稿专家', personaId: personaBId, via: 'manual' });
    const taskId = createAndRunStageableTask();
    ensureStageRuns(db, getTask(db, taskId));

    const out = advanceStageRun(db, taskId, { summary: '阶段一完成' });
    expect(out?.advanced).toBe(true);
    expect(getTask(db, taskId).assigneeAgentId).toBe(spec.agentId);
    expect(currentStageRun(db, taskId)?.assigneeAgentId).toBe(spec.agentId);
  });

  it('末阶段：finished 不回队，全部 passed，正常收口交引擎', () => {
    seedStages([{ id: 's1', step: 1, label: '唯一阶段' }]);
    const taskId = createAndRunStageableTask();
    ensureStageRuns(db, getTask(db, taskId));

    const out = advanceStageRun(db, taskId, { summary: '全部做完' });
    expect(out).toMatchObject({ advanced: false, finished: true });
    expect(getTask(db, taskId).state).toBe('running'); // 未动任务行
    expect(listStageRuns(db, taskId).every((r) => r.status === 'passed')).toBe(true);
    expect(listTaskEvents(db, taskId).some((e) => e.kind === 'stage_completed' && (e.payload as Record<string, unknown>)?.finished === true)).toBe(true);
  });

  it('无阶段行/无 running 返回 null（fail-open 回落旧收口）', () => {
    const plain = createTask(db, { projectId, title: '普通' });
    expect(advanceStageRun(db, plain.id, { summary: 'x' })).toBeNull();

    seedStages([{ id: 's1', step: 1, label: '梳理' }, { id: 's2', step: 2, label: '成稿' }]);
    const taskId = createAndRunStageableTask();
    ensureStageRuns(db, getTask(db, taskId));
    // 阶段全部 pending（无 running）→ 推进不生效
    db.prepare("UPDATE task_stage_run SET status='pending' WHERE task_id=?").run(taskId);
    expect(advanceStageRun(db, taskId, { summary: 'x' })).toBeNull();
  });
});

describe('stageContextSection', () => {
  it('含当前阶段/前序产出交接/纪律行；无阶段为 null', () => {
    expect(stageContextSection(db, 'tk_不存在')).toBeNull();
    seedStages([
      { id: 's1', step: 1, label: '梳理', description: '对齐目标' },
      { id: 's2', step: 2, label: '成稿' },
    ]);
    const taskId = createAndRunStageableTask();
    ensureStageRuns(db, getTask(db, taskId));
    advanceStageRun(db, taskId, { summary: '梳理产出：大纲三幕', artifacts: [{ path: 'outline.md' }] });

    const section = stageContextSection(db, taskId)!;
    expect(section).toContain('阶段 2/2：成稿');
    expect(section).toContain('前序阶段产出');
    expect(section).toContain('大纲三幕');
    expect(section).toContain('outline.md');
    expect(section).toContain('不要越阶段代劳');
  });
});
