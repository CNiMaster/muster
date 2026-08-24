import { clockIn, getWorkbench, restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 指挥系统批次2：蜂群——系统隐形岗 / 工蜂 / 蜂群落地与限额 / 失败可观测（记账·告警·熔断·停群）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
;
import { createAgent, getAgent, listAgents } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { addDependency, claimNextTask, completeTask, createTask, getTask, listTasks, markRunning, failTask } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { listTaskMessages } from '../../src/server/domain/task-message';
import {
  abortSwarm,
  checkSwarmLimits,
  getSwarmRun,
  materializeSwarm,
  SWARM_WORKER_ROLE,
} from '../../src/server/domain/swarm';
import { DISPATCHER_ROLE, ensureSystemAgents, getDispatcherAgentId } from '../../src/server/domain/system-agents';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import { makeTestDb, makeTempGitRepo } from './setup';
import { getWorkbench } from '../../src/server/domain/workbench';

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
  const sys = ensureSystemAgents(db);
  return { company, lead, project, ...sys };
}

describe('W0 系统岗', () => {
  it('ensureSystemAgents 幂等创建养蜂人/裁决法庭/人事；养蜂人与人事可见（组织模型批次二），裁决法庭保持隐形；claimNextTask 可领取', () => {
    const { company, project, dispatcherAgentId } = fixture();
    const again = ensureSystemAgents(db);
    expect(again.dispatcherAgentId).toBe(dispatcherAgentId);
    expect(getAgent(db, dispatcherAgentId).role).toBe(DISPATCHER_ROLE);
    expect(getAgent(db, dispatcherAgentId).isSystem).toBe(true);

    // B5 中央六岗制：养蜂人/人事隐形（visible_in='central' 口子可取）；裁决法庭同制（辩论召集时出场）
    const visible = listAgents(db);
    expect(visible.some((a) => a.id === dispatcherAgentId)).toBe(false);
    expect(visible.some((a) => a.id === again.hrAgentId)).toBe(false);
    expect(visible.some((a) => a.id === again.judgeAgentId)).toBe(false);
    const central = listAgents(db, { visibleIn: 'central' });
    expect(central.some((a) => a.id === dispatcherAgentId)).toBe(true);
    expect(central.some((a) => a.id === again.hrAgentId)).toBe(true);
    expect(central.some((a) => a.id === again.judgeAgentId)).toBe(true);
    expect(listAgents(db, { includeHidden: true }).some((a) => a.id === again.judgeAgentId)).toBe(true);
    void company;

    // 隐藏 ≠ 不可领取：养蜂人任务能被自己的线程领走
    const task = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '组织蜂群', priority: 9 });
    const thread = db.prepare(
      `INSERT INTO project_agent_thread (id, project_id, agent_id, kind, root_thread_id, claude_session_id, context_json, state, created_at, updated_at)
       VALUES ('th_disp_1', ?, ?, 'primary', NULL, NULL, '{}', 'idle', ?, ?)`,
    );
    void thread;
    db.prepare(
      `INSERT INTO project_agent_thread (id, project_id, agent_id, kind, root_thread_id, claude_session_id, context_json, state, created_at, updated_at)
       VALUES ('th_disp_1', ?, ?, 'primary', NULL, NULL, '{}', 'idle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(project.id, dispatcherAgentId);
    const claimed = claimNextTask(db, 'th_disp_1', dispatcherAgentId);
    expect(claimed?.task.id).toBe(task.id);
  });

  it('getDispatcherAgentId 不存在时返回 null 不创建', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_2', name: 'co' });
    expect(getDispatcherAgentId(db, company.id)).toBeNull();
  });
});

describe('W2/W3 工蜂与蜂群落地', () => {
  it('materializeSwarm：建群+蜂任务(depth1)+独立汇总任务+依赖链；蜂是隐藏临时工', () => {
    const { project, dispatcherAgentId } = fixture();
    const projectTask = createProjectTask(db, { projectId: project.id, title: '调研' });
    const rootTask = createTask(db, {
      projectId: project.id,
      projectTaskId: projectTask.id,
      assigneeAgentId: dispatcherAgentId,
      title: '组织蜂群：调研 X',
    });

    const materialized = materializeSwarm(db, rootTask, {
      goal: '调研 X 的三个维度',
      workers: [
        { title: '维度A', brief: '查 A' },
        { title: '维度B', brief: '查 B' },
        { title: '维度C', brief: '查 C' },
      ],
    });
    expect(materialized.beeTaskIds).toHaveLength(3);
    expect(materialized.truncated).toBe(false);

    const swarm = getSwarmRun(db, materialized.swarmId);
    expect(swarm.status).toBe('active');
    expect(swarm.nodesTotal).toBe(4); // 3 蜂 + 1 汇总
    expect(swarm.rootTaskId).toBe(rootTask.id);

    // 蜂任务：depth=1、assignee 是隐藏临时工蜂、有 primary 线程
    for (const beeId of materialized.beeTaskIds) {
      const beeTask = getTask(db, beeId);
      expect(beeTask.swarmDepth).toBe(1);
      expect(beeTask.parentTaskId).toBe(rootTask.id);
      const beeAgent = getAgent(db, beeTask.assigneeAgentId!);
      expect(beeAgent.role).toBe(SWARM_WORKER_ROLE);
      expect(listAgents(db, beeAgent.companyId).some((a) => a.id === beeAgent.id)).toBe(false);
      const thread = db.prepare(
        "SELECT id FROM project_agent_thread WHERE agent_id=? AND kind='primary'",
      ).get(beeAgent.id) as { id: string } | undefined;
      expect(thread).toBeDefined();
    }

    // 汇总任务：依赖全部蜂；根任务依赖汇总
    const synthesis = getTask(db, swarm.synthesisTaskId!);
    expect(synthesis.inputProtocol.swarmSynthesis).toBe(true);
    const deps = db.prepare('SELECT depends_on_id FROM task_dependency WHERE task_id=?').all(synthesis.id) as Array<{ depends_on_id: string }>;
    expect(deps).toHaveLength(3);
    const rootDeps = db.prepare('SELECT depends_on_id FROM task_dependency WHERE task_id=?').all(rootTask.id) as Array<{ depends_on_id: string }>;
    expect(rootDeps.map((d) => d.depends_on_id)).toContain(synthesis.id);

    // 事件留痕
    expect(listTaskEvents(db, rootTask.id).some((e) => e.kind === 'swarm_created')).toBe(true);
  });

  it('超出扇出上限自动截断并留 swarm_plan_truncated', () => {
    const { project, dispatcherAgentId } = fixture();
    const rootTask = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '组织蜂群' });
    const result = materializeSwarm(db, rootTask, {
      goal: 'g',
      workers: Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, brief: 'b' })), // 默认 maxWidth=5
    });
    expect(result.truncated).toBe(true);
    expect(result.beeTaskIds).toHaveLength(5);
    expect(listTaskEvents(db, rootTask.id).some((e) => e.kind === 'swarm_plan_truncated')).toBe(true);
  });
});

describe('W1 限额', () => {
  it('深度超限：深层蜂 outbound 下派被阻断并留 swarm_limit_blocked（默认 maxDepth=3）', () => {
    const { company, project, dispatcherAgentId } = fixture();
    const teammate = createAgent(db, { companyId: company.id, name: 'teammate', role: 'researcher', tempRecruit: true });
    const rootTask = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '组织蜂群' });
    const materialized = materializeSwarm(db, rootTask, {
      goal: 'g',
      workers: [{ title: 'w1', brief: 'b' }],
    });
    // 模拟已达最深层的蜂（depth=3）：直接 SQL 置深并开跑，再 outbound 下派
    const beeTask = getTask(db, materialized.beeTaskIds[0]);
    db.prepare("UPDATE task SET swarm_depth=3, state='running' WHERE id=?").run(beeTask.id);
    completeTask(db, beeTask.id, {
      outcome: 'waiting_dependency',
      summary: '需要下派',
      outboundTasks: [{ recipientAgentId: teammate.id, protocolId: 'p', title: '子任务', payload: {}, priority: 5 }],
      artifacts: [],
    });
    const events = listTaskEvents(db, beeTask.id);
    const blocked = events.find((e) => e.kind === 'swarm_limit_blocked');
    expect(blocked).toBeDefined();
    expect((blocked!.payload as Record<string, unknown>).reason).toContain('最大深度');
    // 子任务未被创建
    const child = db.prepare('SELECT id FROM task WHERE parent_task_id=?').all(beeTask.id) as Array<{ id: string }>;
    expect(child).toHaveLength(0);
  });

  it('总量超限：设置 maxNodes=1 后建 2+1 节点的群直接拒绝', () => {
    const { project, dispatcherAgentId } = fixture();
    db.prepare("INSERT INTO system_setting (key, value, updated_at) VALUES ('swarm_max_nodes', '1', '2026-01-01')").run();
    const rootTask = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '组织蜂群' });
    expect(() => materializeSwarm(db, rootTask, {
      goal: 'g',
      workers: [{ title: 'w1', brief: 'b' }, { title: 'w2', brief: 'b' }], // 2 蜂 + 1 汇总 = 3 > 1
    })).toThrow();
  });
});

describe('W4 失败可观测', () => {
  function makeSwarm(workerCount = 3) {
    const { project, dispatcherAgentId } = fixture();
    const rootTask = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '组织蜂群' });
    const materialized = materializeSwarm(db, rootTask, {
      goal: 'g',
      workers: Array.from({ length: workerCount }, (_, i) => ({ title: `w${i + 1}`, brief: 'b' })),
    });
    return { project, rootTask, materialized, swarmId: materialized.swarmId };
  }

  /** 直接把任务置为终态并过蜂群记账（模拟引擎 completeTask/failTask 的钩子路径）。 */
  function completeBee(beeId: string, summary = 'ok'): void {
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(beeId);
    completeTask(db, beeId, { outcome: 'completed', summary, outboundTasks: [], artifacts: [] });
  }

  function failBee(beeId: string, message = '逻辑错误：参数校验失败'): void {
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(beeId);
    failTask(db, beeId, message);
  }

  it('蜂完成：计数+1、汇总任务收到结构化汇报消息', () => {
    const { materialized, swarmId } = makeSwarm(3);
    completeBee(materialized.beeTaskIds[0], '结论A：X 可行。证据：来源1');
    const swarm = getSwarmRun(db, swarmId);
    expect(swarm.nodesDone).toBe(1);
    const messages = listTaskMessages(db, swarm.synthesisTaskId!);
    expect(messages.some((m) => m.content.includes('[蜂成员汇报]') && m.content.includes('结论A'))).toBe(true);
  });

  it('全部收口：swarm completed + 工蜂被清理（agent 删除）', () => {
    const { materialized, swarmId } = makeSwarm(2);
    for (const id of materialized.beeTaskIds) completeBee(id);
    // 汇总任务也完成（它是计数节点）
    const swarm = getSwarmRun(db, swarmId);
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(swarm.synthesisTaskId!);
    completeTask(db, swarm.synthesisTaskId!, { outcome: 'completed', summary: '收口报告', outboundTasks: [], artifacts: [] });

    const fresh = getSwarmRun(db, swarmId);
    expect(fresh.status).toBe('completed');
    expect(fresh.nodesDone).toBe(3); // 2 蜂 + 汇总
    // 工蜂 agent 已被 dismiss（is_temp_only 硬删）
    for (const id of materialized.beeTaskIds) {
      const assigneeId = (db.prepare('SELECT assignee_agent_id AS a FROM task WHERE id=?').get(id) as { a: string | null }).a;
      expect(assigneeId).toBeNull(); // FK SET NULL = 蜂已删
    }
  });

  it('失败：根任务收到失败通知 + 失败依赖解除（汇总被唤醒继续走）', () => {
    const { materialized, swarmId, rootTask } = makeSwarm(2);
    const swarm = getSwarmRun(db, swarmId);
    // 一只完成、一只失败 → 汇总不再有活跃阻塞 → 恢复 queued
    completeBee(materialized.beeTaskIds[0]);
    failBee(materialized.beeTaskIds[1], '网络崩溃');
    const synthesis = getTask(db, swarm.synthesisTaskId!);
    expect(synthesis.state).toBe('queued');
    const rootMessages = listTaskMessages(db, rootTask.id);
    expect(rootMessages.some((m) => m.content.includes('[蜂成员失败]') && m.content.includes('网络崩溃'))).toBe(true);
  });

  it('失败率 ≥30%（≥3 收口）→ 去重蜂群告警给养蜂人；后续失败只追加不重派（不触发熔断：≤50%）', () => {
    const { materialized, swarmId } = makeSwarm(4);
    completeBee(materialized.beeTaskIds[0]);
    completeBee(materialized.beeTaskIds[1]);
    // 3 收口 1 失败 = 33% ≥30% → 首次告警
    failBee(materialized.beeTaskIds[2]);
    const alerts = db.prepare("SELECT id, input_protocol_json FROM task WHERE title LIKE '[蜂群告警]%'").all() as Array<{ id: string; input_protocol_json: string }>;
    expect(alerts).toHaveLength(1);
    const proto = JSON.parse(alerts[0].input_protocol_json) as { failures: unknown[]; swarmId: string; guidance: string };
    expect(proto.failures).toHaveLength(1);
    expect(proto.swarmId).toBe(swarmId);
    expect(proto.guidance).toContain('补蜂');
    const alertTask = getTask(db, alerts[0].id);
    expect(alertTask.assigneeAgentId).toBe(getTask(db, getSwarmRun(db, swarmId).rootTaskId).assigneeAgentId);
    // 第 4 个失败：4 收口 2 失败 = 50%（不 >50% 不熔断）→ 去重追加进现有告警
    failBee(materialized.beeTaskIds[3]);
    const alertsAfter = db.prepare("SELECT id, input_protocol_json FROM task WHERE title LIKE '[蜂群告警]%'").all() as Array<{ id: string; input_protocol_json: string }>;
    expect(alertsAfter).toHaveLength(1);
    const protoAfter = JSON.parse(alertsAfter[0].input_protocol_json) as { failures: unknown[] };
    expect(protoAfter.failures).toHaveLength(2);
    expect(getSwarmRun(db, swarmId).status).toBe('active'); // 未熔断
  });

  it('失败 >50%（≥2 收口）→ 自动熔断：剩余取消、status=failed、工蜂回收', () => {
    const { materialized, swarmId, rootTask } = makeSwarm(3);
    failBee(materialized.beeTaskIds[0]);
    failBee(materialized.beeTaskIds[1]); // 2 收口 2 失败 = 100% > 50% → 熔断
    const swarm = getSwarmRun(db, swarmId);
    expect(swarm.status).toBe('failed');
    expect(swarm.finishedAt).not.toBeNull();
    // 剩余蜂被取消
    const remaining = getTask(db, materialized.beeTaskIds[2]);
    expect(remaining.state).toBe('cancelled');
    // 根任务被保留（终局报告由养蜂人产出）但被唤醒（依赖视为已收口）
    expect(listTaskEvents(db, rootTask.id).some((e) => e.kind === 'swarm_circuit_broken')).toBe(true);
  });

  it('abortSwarm includeRoot：一键停群——全部取消（含根）+ status=aborted', () => {
    const { materialized, swarmId, rootTask } = makeSwarm(2);
    abortSwarm(db, swarmId, { reason: '用户手动停止', status: 'aborted', includeRoot: true });
    expect(getSwarmRun(db, swarmId).status).toBe('aborted');
    for (const id of [...materialized.beeTaskIds, rootTask.id]) {
      expect(getTask(db, id).state).toBe('cancelled');
    }
  });

  it('补蜂：从带 swarmId 的源任务（告警处置）追加到活跃群，不建新群不建新汇总', () => {
    const { materialized, swarmId } = makeSwarm(2);
    const before = getSwarmRun(db, swarmId);
    const dispatcherTaskId = before.rootTaskId;
    // 模拟告警任务（inputProtocol 带 swarmId）
    const alertTask = createTask(db, {
      projectId: before.projectId,
      parentTaskId: dispatcherTaskId,
      assigneeAgentId: getTask(db, dispatcherTaskId).assigneeAgentId ?? undefined,
      title: '[蜂群告警] 失败率过线，请处置',
      inputProtocol: { reason: 'swarm_alert', swarmId },
      swarmId,
      swarmDepth: 0,
    });
    const appended = materializeSwarm(db, alertTask, { goal: '补做', workers: [{ title: '补蜂1', brief: 'b' }] });
    expect(appended.swarmId).toBe(swarmId);
    expect(appended.synthesisTaskId).toBeNull();
    const after = getSwarmRun(db, swarmId);
    expect(after.nodesTotal).toBe(before.nodesTotal + 1);
  });
});

describe('W3 引擎接线', () => {
  it('养蜂人/负责人返回 swarmPlan → 全额落地；控制面（工蜂）返回被忽略', async () => {
    const { project, dispatcherAgentId, lead } = fixture();
    const projectTask = createProjectTask(db, { projectId: project.id, title: '调研' });

    // 养蜂人任务：假执行器返回 swarmPlan
    const fake = new FakeExecutor();
    fake.script([
      {
        result: {
          outcome: 'completed' as const,
          summary: 'x',
          outboundTasks: [],
          artifacts: [],
          swarmPlan: { goal: '调研 X', workers: [{ title: 'A', brief: 'b1' }, { title: 'B', brief: 'b2' }] },
        },
      },
    ]);
    const engine = new TaskEngine(db, fake);
    const dispTask = createTask(db, { projectId: project.id, projectTaskId: projectTask.id, assigneeAgentId: dispatcherAgentId, title: '组织蜂群：调研 X', priority: 9 });
    db.prepare(
      `INSERT INTO project_agent_thread (id, project_id, agent_id, kind, root_thread_id, claude_session_id, context_json, state, created_at, updated_at)
       VALUES ('th_w3_a', ?, ?, 'primary', NULL, NULL, '{}', 'idle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(project.id, dispatcherAgentId);
    await engine.pumpThread('th_w3_a');

    const after = getTask(db, dispTask.id);
    expect(after.state).toBe('waiting_dependency');
    expect(after.swarmId).not.toBeNull();
    const beeRows = db.prepare(
      "SELECT id FROM task WHERE parent_task_id=? AND input_protocol_json LIKE '%swarm_bee%'",
    ).all(dispTask.id) as Array<{ id: string }>;
    expect(beeRows).toHaveLength(2);
    expect(listTaskEvents(db, dispTask.id).some((e) => e.kind === 'swarm_created')).toBe(true);

    // 派遣分级（批次5）：负责人返回 swarmPlan → 全额落地（不再忽略）
    fake.script([
      {
        result: {
          outcome: 'completed' as const,
          summary: '负责人放蜂',
          outboundTasks: [],
          artifacts: [],
          swarmPlan: { goal: 'g', workers: [{ title: 'x', brief: 'b' }] },
        },
      },
    ]);
    const leadTask = createTask(db, { projectId: project.id, projectTaskId: projectTask.id, assigneeAgentId: lead.id, title: '负责人放蜂', priority: 9 });
    db.prepare(
      `INSERT INTO project_agent_thread (id, project_id, agent_id, kind, root_thread_id, claude_session_id, context_json, state, created_at, updated_at)
       VALUES ('th_w3_b', ?, ?, 'primary', NULL, NULL, '{}', 'idle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(project.id, lead.id);
    await engine.pumpThread('th_w3_b');
    const leadAfter = getTask(db, leadTask.id);
    expect(leadAfter.state).toBe('waiting_dependency');
    expect(db.prepare(
      "SELECT COUNT(*) AS c FROM task WHERE parent_task_id=? AND input_protocol_json LIKE '%swarm_bee%'",
    ).get(leadTask.id)).toMatchObject({ c: 1 });

    // 控制面（蜂群工蜂角色）返回 swarmPlan → 仍忽略（completed 正常落账）
    const beeRole = createAgent(db, { companyId: getWorkbench(db).id, name: '工蜂测试', role: 'swarm-worker', responsibilities: '', contactAllow: [lead.id], tempRecruit: true });
    fake.script([
      {
        result: {
          outcome: 'completed' as const,
          summary: '普通完成',
          outboundTasks: [],
          artifacts: [],
          swarmPlan: { goal: 'g', workers: [{ title: 'x', brief: 'b' }] },
        },
      },
    ]);
    const beeTask = createTask(db, { projectId: project.id, projectTaskId: projectTask.id, assigneeAgentId: beeRole.id, title: '工蜂活', priority: 9, swarmManaged: true });
    db.prepare(
      `INSERT INTO project_agent_thread (id, project_id, agent_id, kind, root_thread_id, claude_session_id, context_json, state, created_at, updated_at)
       VALUES ('th_w3_c', ?, ?, 'primary', NULL, NULL, '{}', 'idle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(project.id, beeRole.id);
    await engine.pumpThread('th_w3_c');
    const beeAfter = getTask(db, beeTask.id);
    expect(beeAfter.state).toBe('completed');
    expect(db.prepare(
      "SELECT COUNT(*) AS c FROM task WHERE parent_task_id=? AND input_protocol_json LIKE '%swarm_bee%'",
    ).get(beeTask.id)).toMatchObject({ c: 0 });
  });
});
