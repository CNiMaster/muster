/**
 * 蓝图组织重构 批次4：选择面规则 + 用户发起探讨 集成测试。
 *
 * 验证：
 * - 选择面规则：@候选/探讨参与者的来源列表（listAgents）排除 hidden 一次性执行体（蜂群工蜂/辩手）。
 * - startUserDiscussion：正常员工可发起（讨论+首发言任务+群聊播报）；
 *   hidden 工蜂、系统隐形岗、跨公司员工作为参与者被拒绝。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent, listAgents } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTempEmployment } from '../../src/server/domain/temp-worker';
import { startUserDiscussion, getDiscussion, listParticipants } from '../../src/server/domain/discussion';
import { createTask, getTask } from '../../src/server/domain/task';
import { ensureDispatcherAgentId } from '../../src/server/domain/system-agents';
import { ensurePrimaryThread } from '../../src/server/domain/thread';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

function seed() {
  const c = createCompany(db, { name: '公司' });
  const lead = createAgent(db, { companyId: c.id, name: '领班', role: 'lead' });
  const member = createAgent(db, { companyId: c.id, name: '成员', role: 'engineer' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, member, p };
}

/** 造一只隐藏工蜂（同 swarm.ts createWorkerBee 的三件套：temp 任职 + hidden + 线程）。 */
function createHiddenBee(companyId: string, projectId: string, requesterAgentId: string): string {
  const { agentId } = createTempEmployment(db, {
    companyId, role: 'swarm-worker', requesterAgentId, name: '工蜂-1', systemPrompt: '一次性工蜂',
  });
  db.prepare('UPDATE company_employee SET hidden=1 WHERE legacy_agent_id=?').run(agentId);
  db.prepare('INSERT INTO project_agent_thread (id, project_id, agent_id, kind, root_thread_id, claude_session_id, context_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, \'{}\', \'idle\', ?, ?)')
    .run(`th_bee_${Date.now()}`, projectId, agentId, 'primary', new Date().toISOString(), new Date().toISOString());
  return agentId;
}

describe('选择面规则：一次性执行体不进用户选择面', () => {
  it('listAgents（@候选/探讨参与者的来源）排除 hidden 工蜂', () => {
    const { c, lead, member, p } = seed();
    const beeId = createHiddenBee(c.id, p.id, lead.id);
    const roster = listAgents(db, c.id);
    expect(roster.some((a) => a.id === lead.id)).toBe(true);
    expect(roster.some((a) => a.id === member.id)).toBe(true);
    expect(roster.some((a) => a.id === beeId)).toBe(false);
  });
});

describe('startUserDiscussion 用户发起探讨', () => {
  it('正常员工：创建讨论 + 首发言任务 + 群聊播报（brainstorm 场景）', () => {
    const { lead, member, p } = seed();
    const result = startUserDiscussion(db, {
      projectId: p.id,
      topic: '方案 A 还是方案 B？',
      participantAgentIds: [lead.id, member.id],
    });
    expect(result.discussion.state).toBe('open');
    expect(result.discussion.context.scenario).toBe('brainstorm');
    expect(result.discussion.context.userInitiated).toBe(true);
    // 首发言任务已创建且可领取
    const turnTask = getTask(db, result.turnTaskId);
    expect(turnTask.isDiscussion).toBe(1);
    expect(turnTask.assigneeAgentId).toBe(lead.id); // 第一位参与者是 moderator
    // 参与者注册
    const participants = listParticipants(db, result.discussion.id);
    expect(participants).toHaveLength(2);
    expect(participants[0]!.role).toBe('moderator');
    // 开场播报到项目群聊
    const broadcast = db.prepare(
      "SELECT content FROM conversation_message WHERE scope_kind='project' AND scope_id=? AND content LIKE '[探讨开始]%'",
    ).get(p.id) as { content: string } | undefined;
    expect(broadcast?.content).toContain('方案 A 还是方案 B？');
    expect(broadcast?.content).toContain('领班');
    expect(broadcast?.content).toContain('成员');
  });

  it('hidden 工蜂作为参与者被拒绝（选择面规则）', () => {
    const { c, lead, member, p } = seed();
    const beeId = createHiddenBee(c.id, p.id, lead.id);
    expect(() => startUserDiscussion(db, {
      projectId: p.id,
      topic: '议题',
      participantAgentIds: [lead.id, beeId],
    })).toThrow(/一次性执行体/);
    // 讨论未被创建
    const count = (db.prepare('SELECT COUNT(*) AS n FROM discussion WHERE project_id=?').get(p.id) as { n: number }).n;
    expect(count).toBe(0);
  });

  it('跨公司员工可参与（公司退役批次D：agent 归属单例工作台，不再拒绝）', () => {
    const { lead, p } = seed();
    const other = createCompany(db, { name: '别家公司' });
    const outsider = createAgent(db, { companyId: other.id, name: '外人', role: 'engineer' });
    expect(() => startUserDiscussion(db, {
      projectId: p.id,
      topic: '议题',
      participantAgentIds: [lead.id, outsider.id],
    })).not.toThrow();
  });

  it('参与者不足 2 人被拒绝', () => {
    const { lead, p } = seed();
    expect(() => startUserDiscussion(db, {
      projectId: p.id,
      topic: '议题',
      participantAgentIds: [lead.id],
    })).toThrow(/至少需要 2 个参与者/);
  });
});

describe('选择面/控制面分离：隐藏执行体的派发边界（Review 修复 I1）', () => {
  it('同项目成员不能直接派发任务给隐藏工蜂（只受直属调度控制）', () => {
    const { c, lead, p } = seed();
    const beeId = createHiddenBee(c.id, p.id, lead.id);
    // 工蜂在该项目有线程（造蜂三件套），但 hidden 非系统任职 → 动态通信图不开放
    expect(() => createTask(db, {
      projectId: p.id,
      dispatcherAgentId: lead.id,
      assigneeAgentId: beeId,
      title: '越权派发给工蜂',
    })).toThrow(/未授权联系/);
  });

  it('系统隐形岗（调度中心）即使 hidden 任职仍可被派发（蜂群链路依赖）', () => {
    const { c, lead, p } = seed();
    const dispatcherId = ensureDispatcherAgentId(db, c.id);
    ensurePrimaryThread(db, p.id, dispatcherId);
    const task = createTask(db, {
      projectId: p.id,
      dispatcherAgentId: lead.id,
      assigneeAgentId: dispatcherId,
      title: '派给调度中心',
    });
    expect(task.assigneeAgentId).toBe(dispatcherId);
  });

  it('可见成员（非 hidden）走团队成员派发保持畅通', () => {
    const { c, lead, p } = seed();
    const member = createAgent(db, { companyId: c.id, name: '成员', role: 'engineer' });
    ensurePrimaryThread(db, p.id, member.id);
    const task = createTask(db, {
      projectId: p.id,
      dispatcherAgentId: lead.id,
      assigneeAgentId: member.id,
      title: '团队协作',
    });
    expect(task.assigneeAgentId).toBe(member.id);
  });
});
