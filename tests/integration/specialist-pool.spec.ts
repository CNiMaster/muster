/**
 * 组织模型批次二：项目专家池——需求计数阶梯（临时蜂→项目专家→常驻专家）、
 * 人事 staffingPlan 兑现、蜂群 persona 蜂池优先、养蜂人/人事可见性。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent, getAgent, listAgents } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { materializeSwarm, SWARM_WORKER_ROLE } from '../../src/server/domain/swarm';
import { ensureSystemAgents } from '../../src/server/domain/system-agents';
import { listPersonaIndex, getPersona } from '../../src/server/domain/persona-library';
import {
  acquireSpecialistForPersona,
  createProjectSpecialist,
  dismissSpecialist,
  listProjectSpecialists,
  listStaffSpecialists,
  materializeStaffingPlan,
  recordSpecialistUse,
} from '../../src/server/domain/specialist-pool';
import { clockIn, restoreWorkbench } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

function fixture() {
  const company = restoreWorkbench(db, { id: 'wb_spc', name: 'co' });
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

/** 取一个仓库内置人设的真实 id（不写任何文件，走只读库）。 */
function realPersonaId(): string {
  const index = listPersonaIndex();
  for (const domain of index) {
    for (const item of domain.items) {
      if (getPersona(item.id)) return item.id;
    }
  }
  throw new Error('内置人设库为空，无法测试 persona 蜂路径');
}

describe('专家池生命周期', () => {
  it('需求计数阶梯：第 1 次只记需求 → 第 2 次落成项目专家 → 之后复用同一专家 → 满使用次数晋升常驻', () => {
    const { project } = fixture();
    // 第 1 次：无行 → 建计数行（agent 空），返回 null（调用方走临时蜂）
    expect(acquireSpecialistForPersona(db, project.id, 'qa/perf', '性能测试')).toBeNull();
    let rows = listProjectSpecialists(db, project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBeNull();
    expect(rows[0]!.useCount).toBe(1);

    // 第 2 次：落成常驻项目专家（agent 落位）
    const second = acquireSpecialistForPersona(db, project.id, 'qa/perf', '性能测试');
    expect(second?.created).toBe(true);
    const specialistAgent = getAgent(db, second!.agentId);
    expect(specialistAgent.role).toBe('specialist');
    expect(listAgents(db).some((a) => a.id === specialistAgent.id)).toBe(true); // 项目可见

    // 第 3 次：复用同一专家（不新建 agent）
    const third = acquireSpecialistForPersona(db, project.id, 'qa/perf', '性能测试');
    expect(third).toEqual({ agentId: second!.agentId, created: false });

    // 使用次数达阈值 → tier 晋升 staff（跨项目可借）
    let entry = listProjectSpecialists(db, project.id)[0]!;
    while (entry.useCount < 5) entry = recordSpecialistUse(db, entry.id);
    expect(listStaffSpecialists(db, 'other-project').some((s) => s.id === entry.id)).toBe(true);
  });

  it('人事 staffingPlan 兑现：逐位建项目专家 + specialist_created 事件；dismiss 只改状态不删行', () => {
    const { project, lead } = fixture();
    const source = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '需要两位专家' });
    const { created } = materializeStaffingPlan(db, source.id, {
      specialists: [
        { specialty: '前端性能优化', brief: '负责首屏指标' },
        { specialty: '视觉走查', personaId: realPersonaId() },
      ],
    });
    expect(created).toHaveLength(2);
    expect(created.every((c) => c.agentId && c.createdVia === 'hr')).toBe(true);
    expect(listAgents(db).filter((a) => a.role === 'specialist')).toHaveLength(2);

    // 只加不减：dismiss 仅改状态，行与 agent 保留
    const dismissed = dismissSpecialist(db, created[0]!.id);
    expect(dismissed.status).toBe('dismissed');
    expect(listProjectSpecialists(db, project.id)).toHaveLength(1); // active 过滤掉
    expect(listProjectSpecialists(db, project.id, { activeOnly: false })).toHaveLength(2);
    expect(getAgent(db, created[0]!.agentId!)).toBeTruthy();
  });

  it('分身优先（2026-08-24 定案）：首次放临时蜂，第二次同专长由常驻专家的分身执行（不占真人、无排队）', () => {
    const { project, dispatcherAgentId } = fixture();
    const personaId = realPersonaId();
    const plan = {
      goal: '批量性能核查',
      workers: [{ title: '子题A', brief: '做基准', personaId }],
    };

    const firstSource = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '放群1' });
    const first = materializeSwarm(db, firstSource, plan, { requesterAgentId: dispatcherAgentId });
    const firstBee = getTask(db, first.beeTaskIds[0]!);
    expect(getAgent(db, firstBee.assigneeAgentId!).role).toBe(SWARM_WORKER_ROLE);

    // 第二次：需求计数已让常驻专家落成——但蜂群不再借调真人，建分身（匿名蜂穿戴人设）
    const secondSource = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '放群2' });
    const second = materializeSwarm(db, secondSource, plan, { requesterAgentId: dispatcherAgentId });
    const secondBee = getTask(db, second.beeTaskIds[0]!);
    const secondAssignee = getAgent(db, secondBee.assigneeAgentId!);
    expect(secondAssignee.role).toBe(SWARM_WORKER_ROLE); // 分身蜂，不是常驻真人（specialist）
    expect(secondBee.personaId).toBe(personaId); // 分身穿戴同一人设（能力延续）
    // 新落成的常驻专家没建线程 → 无快照可聚合，分身退化为纯人设穿戴（优雅不阻断）
    expect((secondBee.inputProtocol as Record<string, unknown>).memorySnapshot).toBeUndefined();
    // 留痕：spawned_child 带 avatar 标记与快照来源
    const evt = db.prepare("SELECT payload_json FROM task_event WHERE task_id=? AND kind='spawned_child' ORDER BY occurred_at DESC LIMIT 1").get(secondSource.id) as { payload_json: string };
    const payload = JSON.parse(evt.payload_json) as { specialist?: boolean; avatar?: boolean; snapshotFrom?: string };
    expect(payload.specialist).toBe(true);
    expect(payload.avatar).toBe(true);
    expect(typeof payload.snapshotFrom).toBe('string'); // 指向常驻专家 agentId
  });

  it('同 persona 多节点群 → 每节点独立分身并行（互不相同的 assignee，全部不指向常驻真人）', () => {
    const { project, dispatcherAgentId } = fixture();
    const personaId = realPersonaId();
    // 先放一次单蜂群让常驻专家落成（第二次需求转常驻）
    const warm = { goal: '热身', workers: [{ title: '热身子题', brief: 'x', personaId }] };
    const warmSource = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '放群0' });
    materializeSwarm(db, warmSource, warm, { requesterAgentId: dispatcherAgentId });

    const plan = {
      goal: '三路并行评审',
      workers: [
        { title: '子题一', brief: 'b', personaId },
        { title: '子题二', brief: 'b', personaId },
        { title: '子题三', brief: 'b', personaId },
      ],
    };
    const source = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '放群并行' });
    const swarm = materializeSwarm(db, source, plan, { requesterAgentId: dispatcherAgentId });
    const assignees = swarm.beeTaskIds.map((id) => getTask(db, id).assigneeAgentId!);
    expect(assignees).toHaveLength(3);
    expect(new Set(assignees).size).toBe(3); // 三只分身各持独立线程租约——排队消除的直接断言
    for (const beeId of swarm.beeTaskIds) {
      const bee = getTask(db, beeId);
      expect(getAgent(db, bee.assigneeAgentId!).role).toBe(SWARM_WORKER_ROLE);
      expect(bee.personaId).toBe(personaId);
    }
  });

  it('常驻专家有线程摘要时 → 分身蜂任务注入只读记忆快照', () => {
    const { project, dispatcherAgentId } = fixture();
    const personaId = realPersonaId();
    const warm = { goal: '热身', workers: [{ title: '热身子题', brief: 'x', personaId }] };
    const warmSource = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '放群0' });
    materializeSwarm(db, warmSource, warm, { requesterAgentId: dispatcherAgentId });
    // 第二次落成常驻后，给它种 primary thread + 压缩摘要
    const second = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '放群1' });
    materializeSwarm(db, second, warm, { requesterAgentId: dispatcherAgentId });
    const entry = db.prepare('SELECT agent_id FROM specialist_pool WHERE project_id=? AND persona_id=?').get(project.id, personaId) as { agent_id: string };
    const thread = ensurePrimaryThread(db, project.id, entry.agent_id);
    db.prepare('UPDATE project_agent_thread SET compaction_summary=? WHERE id=?').run('评审一律先查边界条件再谈实现。', thread.id);

    const source = createTask(db, { projectId: project.id, assigneeAgentId: dispatcherAgentId, title: '放群快照' });
    const swarm = materializeSwarm(db, source, { goal: '快照验证', workers: [{ title: '子题', brief: 'b', personaId }] }, { requesterAgentId: dispatcherAgentId });
    const bee = getTask(db, swarm.beeTaskIds[0]!);
    const snapshot = (bee.inputProtocol as Record<string, unknown>).memorySnapshot;
    expect(typeof snapshot).toBe('string');
    expect(snapshot as string).toContain('评审一律先查边界条件');
    // 只读外借：常驻专家的线程摘要本体未被改动
    expect(db.prepare('SELECT compaction_summary FROM project_agent_thread WHERE id=?').get(thread.id)).toEqual({ compaction_summary: '评审一律先查边界条件再谈实现。' });
  });

  it('createProjectSpecialist：persona 存在时以人设名命名，缺失时以专长命名（不阻断）', () => {
    const { project } = fixture();
    const withPersona = createProjectSpecialist(db, { projectId: project.id, specialty: '调研', personaId: realPersonaId(), via: 'manual' });
    expect(getAgent(db, withPersona.agentId!).name).toBe(getPersona(realPersonaId())!.name);
    const anonymous = createProjectSpecialist(db, { projectId: project.id, specialty: '通用排查', personaId: 'no/such', via: 'manual' });
    expect(getAgent(db, anonymous.agentId!).name).toContain('通用排查');
  });
});
