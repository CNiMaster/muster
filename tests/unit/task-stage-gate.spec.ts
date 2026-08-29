/**
 * 阶段门与阶段统计（蓝图工作流化批次B M2，2026-08-29）：
 * - checkStageGate：无门返回 null 不调 LLM；self-check pass/fail；LLM 不可用 fail-open 放行+留痕；
 *   acceptance 门用验收员口径；连续未过达上限自动放行（门是增强不是死锁）
 * - failStageGate：阶段 attempt++ 留 running、任务回队列不换人、事件留痕
 * - recordBlueprintStageStats：runs/reworks/gate_fails 聚合 + 二次累加
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb, createNovelCompany } from '../integration/setup';

vi.mock('../../src/server/domain/llm-call', () => ({ callLlm: vi.fn() }));
import { callLlm } from '../../src/server/domain/llm-call';
const callLlmMock = callLlm as unknown as ReturnType<typeof vi.fn>;

import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, claimNextTask, markRunning } from '../../src/server/domain/task';
import { evolveBlueprint, publishBlueprintDebugResult } from '../../src/server/domain/blueprint';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { listPersonas } from '../../src/server/domain/persona-library';
import { listTaskEvents } from '../../src/server/domain/task-event';
import {
  ensureStageRuns, listStageRuns, checkStageGate, failStageGate, recordBlueprintStageStats,
} from '../../src/server/domain/task-stage';

let db: DB;
let projectId: string;
let leadAgentId: string;
let blueprintId: string;
let personaAId: string;

beforeEach(() => {
  callLlmMock.mockReset();
  const tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  leadAgentId = r.agents.lead.id;
  projectId = createProject(db, { companyId: r.company.id, name: 'p', rootDir: '/tmp/gate', firstAgentId: leadAgentId, initialState: 'active' }).id;
  const persona = listPersonas()[0]!;
  personaAId = persona.id;
  const bp = evolveBlueprint(db, { companyId: r.company.id, projectId, taskTitle: '门测试_xyz', personaId: persona.id, personaName: persona.name, win: true })!;
  blueprintId = bp.id;
});

function seedStages(stages: Array<{ id: string; step: number; label: string; gate?: 'self-check' | 'acceptance' }>): void {
  publishBlueprintDebugResult(db, {
    blueprintId,
    staffing: [{ personaId: personaAId, personaName: '主责A' }],
    stages,
    summary: '布景',
  });
}

function createAndRunStageableTask(): string {
  const task = createTask(db, { projectId, title: '走门流水线', blueprintId });
  const thread = ensurePrimaryThread(db, projectId, leadAgentId);
  for (let i = 0; i < 10; i++) {
    if (claimNextTask(db, thread.id, leadAgentId)?.task.id === task.id) break;
  }
  markRunning(db, task.id);
  ensureStageRuns(db, getTask(db, task.id));
  return task.id;
}

describe('checkStageGate', () => {
  it('无门（缺省 none）返回 null，不调 LLM', async () => {
    seedStages([{ id: 's1', step: 1, label: '无门阶段' }]);
    const taskId = createAndRunStageableTask();
    expect(await checkStageGate(db, taskId, { summary: '完成' })).toBeNull();
    expect(callLlmMock).not.toHaveBeenCalled();
  });

  it('self-check：fail → 未过带原因；failStageGate 同 assignee 回队+attempt++', async () => {
    seedStages([{ id: 's1', step: 1, label: '成稿', gate: 'self-check' }]);
    const taskId = createAndRunStageableTask();
    callLlmMock.mockResolvedValueOnce({ content: '{"verdict":"fail","reason":"产出为空，与阶段目标无关"}' });

    const gate = await checkStageGate(db, taskId, { summary: '' });
    expect(gate).toMatchObject({ pass: false, note: '产出为空，与阶段目标无关' });

    const landed = failStageGate(db, taskId, gate!.note);
    expect(landed).toMatchObject({ step: 1, total: 1 });
    const task = getTask(db, taskId);
    expect(task.state).toBe('queued');
    expect(task.assigneeAgentId).toBe(leadAgentId); // 不换人
    expect(listStageRuns(db, taskId)[0]!.attempt).toBe(1);
    expect(listStageRuns(db, taskId)[0]!.status).toBe('running');
    expect(listTaskEvents(db, taskId).some((e) => e.kind === 'stage_gate_failed')).toBe(true);
  });

  it('pass → 放行；LLM 不可用 → fail-open 放行 + stage_gate_skipped 留痕', async () => {
    seedStages([{ id: 's1', step: 1, label: '成稿', gate: 'self-check' }]);
    const taskId = createAndRunStageableTask();

    callLlmMock.mockResolvedValueOnce({ content: '{"verdict":"pass","reason":"产出对齐目标"}' });
    expect(await checkStageGate(db, taskId, { summary: '写完终稿' })).toMatchObject({ pass: true });

    callLlmMock.mockRejectedValueOnce(new Error('no credentials'));
    const fallback = await checkStageGate(db, taskId, { summary: '写完终稿' });
    expect(fallback!.pass).toBe(true);
    expect(listTaskEvents(db, taskId).some((e) => e.kind === 'stage_gate_skipped')).toBe(true);
  });

  it('acceptance 门 system 用验收员口径；解析失败 fail-open 放行', async () => {
    seedStages([{ id: 's1', step: 1, label: '终审', gate: 'acceptance' }]);
    const taskId = createAndRunStageableTask();
    callLlmMock.mockResolvedValueOnce({ content: '我认为可以' }); // 非 JSON

    const gate = await checkStageGate(db, taskId, { summary: '终稿已交付' });
    expect(gate!.pass).toBe(true);
    const system = callLlmMock.mock.calls[0]![1].system as string;
    expect(system).toContain('验收员');
  });

  it('连续未过达上限（已 2 次 fail 事件）→ 自动放行 + stage_gate_escalated', async () => {
    seedStages([{ id: 's1', step: 1, label: '成稿', gate: 'self-check' }]);
    const taskId = createAndRunStageableTask();
    // 人为预置两轮门失败史（第 3 次评审再 fail 应自动放行）——直接落事件，避免 failStageGate 的状态守卫连锁
    const { appendTaskEvent } = await import('../../src/server/domain/task-event');
    appendTaskEvent(db, taskId, 'stage_gate_failed', { step: 1, label: '成稿', note: '第一轮未过', attempt: 1 });
    appendTaskEvent(db, taskId, 'stage_gate_failed', { step: 1, label: '成稿', note: '第二轮未过', attempt: 2 });
    callLlmMock.mockResolvedValueOnce({ content: '{"verdict":"fail","reason":"还是不行"}' });

    const gate = await checkStageGate(db, taskId, { summary: '第三轮产出' });
    expect(gate!.pass).toBe(true);
    expect(gate!.note).toContain('自动放行');
    expect(listTaskEvents(db, taskId).some((e) => e.kind === 'stage_gate_escalated')).toBe(true);
  });
});

describe('recordBlueprintStageStats', () => {
  it('runs/reworks/gate_fails 聚合正确；二次调用累加', () => {
    seedStages([
      { id: 's1', step: 1, label: '梳理' },
      { id: 's2', step: 2, label: '成稿', gate: 'self-check' },
    ]);
    const taskId = createAndRunStageableTask();
    // 推进到 s2 并让它门失败两次（attempt=2 → rework 1；gate_fails 2）
    db.prepare("UPDATE task_stage_run SET status='passed', finished_at=? WHERE stage_id='s1'").run(new Date().toISOString());
    db.prepare("UPDATE task_stage_run SET status='running', attempt=1 WHERE stage_id='s2'").run();
    failStageGate(db, taskId, '第一轮未过');

    recordBlueprintStageStats(db, blueprintId, taskId);
    let rows = db.prepare('SELECT stage_id, runs, reworks, gate_fails FROM blueprint_stage_stat WHERE blueprint_id=? ORDER BY stage_id').all(blueprintId) as Array<{ stage_id: string; runs: number; reworks: number; gate_fails: number }>;
    expect(rows).toEqual([
      { stage_id: 's1', runs: 1, reworks: 0, gate_fails: 0 },
      { stage_id: 's2', runs: 1, reworks: 1, gate_fails: 1 },
    ]);

    recordBlueprintStageStats(db, blueprintId, taskId); // 同任务二次结算 → 累加
    rows = db.prepare('SELECT stage_id, runs, reworks, gate_fails FROM blueprint_stage_stat WHERE blueprint_id=? ORDER BY stage_id').all(blueprintId) as typeof rows;
    expect(rows[1]).toEqual({ stage_id: 's2', runs: 2, reworks: 2, gate_fails: 2 });
  });
});
