import { clockIn, restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 指挥系统 review 修复回归（B1 记账 / B2 隐岗线程 / I3 行映射 / I5 辩论失败 / I6 决策去重 / I7 done 契约）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { claimNextTask, completeTask, createTask, failTask, getTask, listTasksBySwarm } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { listMessages } from '../../src/server/domain/conversation';
import { getSwarmRun, materializeSwarm, SWARM_WORKER_ROLE } from '../../src/server/domain/swarm';
import { ensureSystemAgents } from '../../src/server/domain/system-agents';
import { startDebate, finalizeDebate, recentDecisions, DEBATER_ROLE } from '../../src/server/domain/debate';
import { createBuiltinToolRegistry } from '../../src/server/executors/tools/registry';
import type { QuestionOption } from '../../src/shared/types';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

function fixture() {
  const company = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' });
  const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
  const project = createProject(db, {
    companyId: company.id,
    name: 'p1',
    rootDir: makeTempGitRepo(),
    firstAgentId: lead.id,
    initialState: 'active',
  });
  clockIn(db);
  const sys = ensureSystemAgents(db, company.id);
  return { company, lead, project, ...sys };
}

const OPTIONS: QuestionOption[] = [
  { id: 'a', label: '方案A' },
  { id: 'b', label: '方案B' },
];

describe('B1：蜂群子任务入账 nodes_total（防提前 closeSwarm 误回收在飞工蜂）', () => {
  it('根调度任务 outbound 下派子任务 → nodes_total 同步 +1；全部结算后才关群', () => {
    const { lead, project, dispatcherAgentId } = fixture();
    const rootTask = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '组织蜂群' });
    const materialized = materializeSwarm(db, rootTask, {
      goal: 'g',
      workers: [{ title: 'w1', brief: 'b' }],
    });
    const swarmId = materialized.swarmId;
    expect(getSwarmRun(db, swarmId).nodesTotal).toBe(2); // 1 蜂 + 1 汇总

    // 根调度任务运行中经 outbound 再补一只蜂（系统岗豁免 contactAllow；子任务继承群 depth=1）
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(rootTask.id);
    completeTask(db, rootTask.id, {
      outcome: 'waiting_dependency',
      summary: '补派一只',
      outboundTasks: [{ recipientAgentId: lead.id, protocolId: 'p', title: '子蜂任务', payload: {}, priority: 5 }],
      artifacts: [],
    });
    expect(getSwarmRun(db, swarmId).nodesTotal).toBe(3); // +1 子任务（修复前停留在 2 → 结算时提前关群）
    const child = db.prepare('SELECT id FROM task WHERE parent_task_id=? AND title=?').get(rootTask.id, '子蜂任务') as { id: string };
    expect(child).toBeDefined();
    expect(getTask(db, child.id).swarmDepth).toBe(1);

    // 工蜂完成 → done=1；子任务完成 → done=2；汇总未完成 → 不得关群
    const beeTask = getTask(db, materialized.beeTaskIds[0]);
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(beeTask.id);
    completeTask(db, beeTask.id, { outcome: 'completed', summary: '蜂完成', outboundTasks: [], artifacts: [] });
    expect(getSwarmRun(db, swarmId).status).toBe('active');
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(child.id);
    completeTask(db, child.id, { outcome: 'completed', summary: '子完成', outboundTasks: [], artifacts: [] });
    expect(getSwarmRun(db, swarmId).status).toBe('active'); // 汇总还没跑（修复前 done=2=total 已提前关群并误回收）
    expect(getSwarmRun(db, swarmId).nodesDone).toBe(2);

    // 汇总完成 → done=3=total → 关群 + 工蜂回收
    const swarm = getSwarmRun(db, swarmId);
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(swarm.synthesisTaskId!);
    completeTask(db, swarm.synthesisTaskId!, { outcome: 'completed', summary: '收口', outboundTasks: [], artifacts: [] });
    const closed = getSwarmRun(db, swarmId);
    expect(closed.status).toBe('completed');
    expect(db.prepare('SELECT COUNT(*) AS c FROM agent_definition WHERE role=?').get(SWARM_WORKER_ROLE)).toMatchObject({ c: 0 });
  });
});

describe('B2：任务指派给系统隐形岗时自动建线程（首个调度任务可领取）', () => {
  it('员工 outboundTasks 派给调度中心（不手动建线程）→ 线程自动创建且任务可被领取', () => {
    const { lead, project, dispatcherAgentId } = fixture();
    // lead 的任务带调度中心联系人权限（contactAllow 校验）——先给 lead 加联系人
    db.prepare('UPDATE agent_definition SET contact_allow_json=? WHERE id=?').run(JSON.stringify([dispatcherAgentId]), lead.id);
    const leadTask = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '组织调研' });
    db.prepare(
      `INSERT INTO project_agent_thread (id, project_id, agent_id, kind, root_thread_id, claude_session_id, context_json, state, created_at, updated_at)
       VALUES ('th_fix_lead', ?, ?, 'primary', NULL, NULL, '{}', 'idle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(project.id, lead.id);
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(leadTask.id);
    completeTask(db, leadTask.id, {
      outcome: 'completed',
      summary: '转交调度中心',
      outboundTasks: [{ recipientAgentId: dispatcherAgentId, protocolId: 'p', title: '组织蜂群：调研 X', payload: {}, priority: 7 }],
      artifacts: [],
    });

    // 修复点：dispatch 任务创建时自动给系统岗建了线程
    const dispThread = db.prepare(
      "SELECT id FROM project_agent_thread WHERE agent_id=? AND project_id=? AND kind='primary'",
    ).get(dispatcherAgentId, project.id) as { id: string } | undefined;
    expect(dispThread).toBeDefined();
    const dispTask = db.prepare('SELECT id FROM task WHERE assignee_agent_id=? AND title LIKE ?').get(dispatcherAgentId, '组织蜂群：%') as { id: string };
    expect(dispTask).toBeDefined();
    const claimed = claimNextTask(db, dispThread!.id, dispatcherAgentId);
    expect(claimed?.task.id).toBe(dispTask.id);
  });
});

describe('I3：/swarm 数据源 camelCase 映射', () => {
  it('listTasksBySwarm 返回 camelCase 字段（parentTaskId 可用于建树）', () => {
    const { project, dispatcherAgentId } = fixture();
    const rootTask = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '组织蜂群' });
    const materialized = materializeSwarm(db, rootTask, { goal: 'g', workers: [{ title: 'w1', brief: 'b' }] });
    const tasks = listTasksBySwarm(db, materialized.swarmId);
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    for (const t of tasks) {
      expect(t.parentTaskId).toBeDefined(); // snake_case 裸行这里是 undefined
      expect(t.swarmDepth).toBeDefined();
    }
    const bee = tasks.find((t) => t.parentTaskId === rootTask.id && t.swarmDepth === 1);
    expect(bee).toBeDefined();
  });
});

describe('I5：辩论失败自救（下游取消 + 升级用户 + 辩手回收）', () => {
  it('R1 失败 → 辩论 escalated、R2/裁决取消、辩手回收、对话收到原问题', () => {
    const { company, lead, project } = fixture();
    const origin = createTask(db, {
      projectId: project.id,
      assigneeAgentId: lead.id,
      title: '两难',
      priority: 9,
      inputProtocol: { trigger: 'user_message', scope: 'workbench', scopeId: company.id, content: '帮我权衡' },
    });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(origin.id);
    completeTask(db, origin.id, {
      outcome: 'waiting_input',
      summary: '两难',
      question: '选 A 还是 B？',
      questionOptions: OPTIONS,
      outboundTasks: [],
      artifacts: [],
    });
    const started = startDebate(db, {
      companyId: company.id,
      projectId: project.id,
      question: '选 A 还是 B？',
      options: OPTIONS,
      originTaskId: origin.id,
      originScopeKind: 'workbench',
      originScopeId: company.id,
    });
    const r1 = getTask(db, started.debaterTaskIds[0]);

    // R1 失败（不可重试的永久错误）
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(r1.id);
    failTask(db, r1.id, '权限拒绝：无法访问资料');

    const debateRow = db.prepare('SELECT status FROM debate WHERE id=?').get(started.debateId) as { status: string };
    expect(debateRow.status).toBe('escalated');
    // R2 + 裁决被取消
    for (const id of [...started.debaterTaskIds.slice(2), started.verdictTaskId]) {
      expect(getTask(db, id).state).toBe('cancelled');
    }
    // 另一只 R1 也被取消（同辩论剩余任务全停）
    expect(getTask(db, started.debaterTaskIds[1]).state).toBe('cancelled');
    // 辩手回收
    expect(db.prepare('SELECT COUNT(*) AS c FROM agent_definition WHERE role=?').get(DEBATER_ROLE)).toMatchObject({ c: 0 });
    // 原任务保持 waiting_input，对话收到问题原文（升级兜底）
    expect(getTask(db, origin.id).state).toBe('waiting_input');
    const msgs = listMessages(db, 'workbench', company.id);
    expect(msgs.some((m) => m.content.includes('[需要你拍板]') && m.content.includes('A. 方案A'))).toBe(true);
    expect(listTaskEvents(db, origin.id).some((e) => e.kind === 'debate_failed')).toBe(true);
  });
});

describe('I6：评审庭自动采纳不再污染 user 偏好记录', () => {
  it('finalizeDebate 自动采纳后 decision_record 只有 1 条且 source=auto', () => {
    const { company, project, judgeAgentId } = fixture();
    const origin = createTask(db, { projectId: project.id, assigneeAgentId: judgeAgentId, title: '两难' });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(origin.id);
    completeTask(db, origin.id, {
      outcome: 'waiting_input',
      summary: '两难',
      question: '选哪个？',
      questionOptions: OPTIONS,
      outboundTasks: [],
      artifacts: [],
    });
    const started = startDebate(db, {
      companyId: company.id,
      projectId: project.id,
      question: '选哪个？',
      options: OPTIONS,
      originTaskId: origin.id,
    });
    finalizeDebate(db, started.debateId, {
      debateId: started.debateId,
      recommendedOptionId: 'a',
      confidence: 0.9,
      rationale: '明确。',
      flaws: [],
    });
    const decisions = recentDecisions(db, company.id);
    expect(decisions).toHaveLength(1); // 修复前会有 2 条（一条误标 user + 一条 auto）
    expect(decisions[0].source).toBe('auto');
    expect(getTask(db, origin.id).state).toBe('queued');
  });
});

describe('I7：API 执行器 done 工具契约包含新结构化字段', () => {
  it('done 定义含 questionOptions/swarmPlan/debateVerdict', async () => {
    const registry = await createBuiltinToolRegistry();
    const defs = registry.definitions();
    const done = defs.find((d) => d.function?.name === 'done' || (d as { name?: string }).name === 'done');
    expect(done).toBeDefined();
    const json = JSON.stringify(done);
    expect(json).toContain('questionOptions');
    expect(json).toContain('swarmPlan');
    expect(json).toContain('debateVerdict');
  });
});
