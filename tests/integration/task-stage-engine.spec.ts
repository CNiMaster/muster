/**
 * 引擎级端到端：蓝图阶段流水线（批次④ M1）。
 * FakeExecutor 两幕脚本驱动：阶段 1 完成 → 引擎拦截不收口（任务回 queued+改派阶段 2 专家）
 * → 专家线程跑阶段 2 → 末阶段正常 completed 收口。
 * 同一 worktree 跨阶段延续（产物交接）；无蓝图任务跑一遍对照零行为变化。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestDb, makeTempGitRepo, createNovelCompany } from './setup';

vi.mock('../../src/server/domain/llm-call', () => ({ callLlm: vi.fn() }));
import type { DB } from '../../src/server/db/client';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask } from '../../src/server/domain/task';
import { evolveBlueprint, publishBlueprintDebugResult } from '../../src/server/domain/blueprint';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { listPersonas } from '../../src/server/domain/persona-library';
import { createProjectSpecialist } from '../../src/server/domain/specialist-pool';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { listStageRuns } from '../../src/server/domain/task-stage';
import { callLlm } from '../../src/server/domain/llm-call';
const callLlmMock = callLlm as unknown as ReturnType<typeof vi.fn>;
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';

let db: DB;
let workbenchId: string;
let projectId: string;
let leadAgentId: string;
let personaAId: string;
let personaBId: string;
let blueprintId: string;
let specialistAgentId: string;

beforeEach(() => {
  const tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  workbenchId = r.company.id;
  leadAgentId = r.agents.lead.id;
  const project = createProject(db, { companyId: workbenchId, name: '流水线项目', rootDir: makeTempGitRepo(), firstAgentId: leadAgentId, initialState: 'active' });
  projectId = project.id;

  const [pa, pb] = listPersonas();
  personaAId = pa.id;
  personaBId = pb.id;
  const bp = evolveBlueprint(db, {
    companyId: workbenchId, projectId, taskTitle: '流水线端到端_xyz',
    personaId: personaAId, personaName: pa.name, win: true,
  })!;
  blueprintId = bp.id;
  publishBlueprintDebugResult(db, {
    blueprintId,
    staffing: [
      { personaId: personaAId, personaName: pa.name, role: '主责' },
      { personaId: personaBId, personaName: pb.name, role: '成稿' },
    ],
    stages: [
      { id: 's1', step: 1, label: '梳理与大纲', description: '对齐目标并产出大纲' },
      { id: 's2', step: 2, label: '成稿交付', staffingPersonaIds: [personaBId] },
    ],
    summary: '端到端布景：两阶段流水线',
  });
  const spec = createProjectSpecialist(db, { projectId, specialty: '成稿专家', personaId: personaBId, via: 'manual' });
  specialistAgentId = spec.agentId!;
  callLlmMock.mockReset();
});

describe('蓝图阶段流水线（引擎端到端）', () => {
  it('两阶段：阶段1拦截推进+改派专家 → 阶段2收口 completed；产物与事件全程留痕', async () => {
    const task = createTask(db, { projectId, title: '按流水线写一份方案', blueprintId });
    const leadThread = ensurePrimaryThread(db, projectId, leadAgentId);
    const specThread = ensurePrimaryThread(db, projectId, specialistAgentId);

    const fake = new FakeExecutor().script([
      {
        writeFiles: { 'outline.md': '# 大纲\n三步走' },
        result: {
          outcome: 'completed',
          summary: '梳理完成：产出三步走大纲',
          outboundTasks: [],
          artifacts: [{ path: 'outline.md', kind: 'markdown', operation: 'create' }],
        },
      },
      {
        writeFiles: { 'final.md': '# 终稿\n按大纲成稿' },
        result: {
          outcome: 'completed',
          summary: '成稿完成：终稿交付',
          outboundTasks: [],
          artifacts: [{ path: 'final.md', kind: 'markdown', operation: 'create' }],
        },
      },
    ]);
    const engine = new TaskEngine(db, fake);

    // 第一幕：负责人领取（assignee 未定 → 首席可领）跑阶段 1，完成后被引擎拦截推进
    expect(await engine.pumpThread(leadThread.id)).toBe(true);
    const mid = getTask(db, task.id);
    expect(mid.state).toBe('queued'); // 未收口，回队列等阶段 2
    expect(mid.assigneeAgentId).toBe(specialistAgentId); // 阶段 2 绑定 personaB → 常驻专家接手

    const midRuns = listStageRuns(db, task.id);
    expect(midRuns).toHaveLength(2);
    expect(midRuns[0]).toMatchObject({ status: 'passed', label: '梳理与大纲', summary: '梳理完成：产出三步走大纲' });
    expect(midRuns[0].artifacts.map((a) => a.path)).toEqual(['outline.md']);
    expect(midRuns[1]).toMatchObject({ status: 'running', label: '成稿交付', assigneeAgentId: specialistAgentId });
    const events = listTaskEvents(db, task.id);
    expect(events.some((e) => e.kind === 'stage_plan_frozen')).toBe(true);
    expect(events.some((e) => e.kind === 'stage_advanced')).toBe(true);
    expect(fake.callCount).toBe(1); // 阶段 2 还没跑

    // 第二幕：专家线程领取阶段 2，末阶段正常收口
    expect(await engine.pumpThread(specThread.id)).toBe(true);
    const done = getTask(db, task.id);
    expect(done.state).toBe('completed');
    expect(done.summary).toBe('成稿完成：终稿交付');
    const finalRuns = listStageRuns(db, task.id);
    expect(finalRuns.every((r) => r.status === 'passed')).toBe(true);
    expect(finalRuns[1].summary).toBe('成稿完成：终稿交付');
    expect(listTaskEvents(db, task.id).some((e) => e.kind === 'stage_completed' && (e.payload as Record<string, unknown>)?.finished === true)).toBe(true);
    expect(fake.callCount).toBe(2);
  });

  it('无蓝图任务对照：一跑即 completed，零阶段行为', async () => {
    const task = createTask(db, { projectId, title: '普通任务不走流水线', assigneeAgentId: leadAgentId });
    const leadThread = ensurePrimaryThread(db, projectId, leadAgentId);
    const fake = new FakeExecutor().script([
      { result: { outcome: 'completed', summary: '直接完成', outboundTasks: [], artifacts: [] } },
    ]);
    const engine = new TaskEngine(db, fake);
    expect(await engine.pumpThread(leadThread.id)).toBe(true);
    expect(getTask(db, task.id).state).toBe('completed');
    expect(listStageRuns(db, task.id)).toHaveLength(0);
    expect(fake.callCount).toBe(1);
  });
});


describe('阶段门端到端（M2 批次B）', () => {
  it('门失败一次 → 同阶段同执行者重跑 → 过门收口 completed', async () => {
    // 布景覆盖：s2 带轻量自检门
    const [pa, pb] = listPersonas();
    publishBlueprintDebugResult(db, {
      blueprintId,
      staffing: [
        { personaId: personaAId, personaName: pa.name, role: '主责' },
        { personaId: personaBId, personaName: pb.name, role: '成稿' },
      ],
      stages: [
        { id: 's1', step: 1, label: '梳理与大纲' },
        { id: 's2', step: 2, label: '成稿交付', gate: 'self-check', staffingPersonaIds: [personaBId] },
      ],
      summary: '门布景：二阶段带 self-check 门',
    });

    const task = createTask(db, { projectId, title: '带门流水线', blueprintId });
    const leadThread = ensurePrimaryThread(db, projectId, leadAgentId);
    const specThread = ensurePrimaryThread(db, projectId, specialistAgentId);
    const fake = new FakeExecutor().script([
      { result: { outcome: 'completed', summary: '梳理完成', outboundTasks: [], artifacts: [] } },
      { result: { outcome: 'completed', summary: '成稿第一轮', outboundTasks: [], artifacts: [] } },
      { result: { outcome: 'completed', summary: '成稿第二轮（修正后）', outboundTasks: [], artifacts: [] } },
    ]);
    // 门评审：第一轮 fail（针对性原因），第二轮 pass
    callLlmMock
      .mockResolvedValueOnce({ content: '{"verdict":"fail","reason":"产出缺少成稿文件"}' })
      .mockResolvedValueOnce({ content: '{"verdict":"pass","reason":"产出对齐目标"}' });

    const engine = new TaskEngine(db, fake);
    expect(await engine.pumpThread(leadThread.id)).toBe(true); // s1 过门（无门）推进 s2
    expect(getTask(db, task.id).assigneeAgentId).toBe(specialistAgentId);

    expect(await engine.pumpThread(specThread.id)).toBe(true); // s2 完成 → 门 fail → 重排
    const gated = getTask(db, task.id);
    expect(gated.state).toBe('queued'); // 未收口
    expect(gated.assigneeAgentId).toBe(specialistAgentId); // 不换人
    const runsMid = listStageRuns(db, task.id);
    expect(runsMid[1]).toMatchObject({ status: 'running', attempt: 2 });
    expect(listTaskEvents(db, task.id).some((e) => e.kind === 'stage_gate_failed')).toBe(true);
    expect(fake.callCount).toBe(2);

    expect(await engine.pumpThread(specThread.id)).toBe(true); // s2 重跑 → 门 pass → 末阶段收口
    expect(getTask(db, task.id).state).toBe('completed');
    expect(listStageRuns(db, task.id).every((r) => r.status === 'passed')).toBe(true);
    expect(fake.callCount).toBe(3);
  });
});
