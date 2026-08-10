/**
 * Discussion 并行轮次（阶段七任务 7.3）集成测试。
 *
 * 验证：
 * 1. parallel 模式：一轮为所有参与者各建一个发言 task
 * 2. 本轮全部发言完成后创建 synthesis task（moderator 汇总）
 * 3. synthesis 完成后进入下一轮（再为所有参与者建发言 task）
 * 4. 达到 maxTurns 后进入 concluding
 * 5. sequential 模式行为不变
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import {
  createDiscussion,
  startDiscussion,
  completeDiscussionTurn,
  getDiscussion,
  listParticipants,
} from '../../src/server/domain/discussion';
import { createTask } from '../../src/server/domain/task';
import { executeTool, createBuiltinToolRegistry, type ToolCall } from '../../src/server/executors/tools/registry';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

function fixture() {
  const c = createCompany(db, { name: 'co' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
  const designer = createAgent(db, { companyId: c.id, name: 'designer', role: 'designer' });
  const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
  return { c, lead, writer, designer, project };
}

/** 取讨论室当前活跃发言 task（current_turn_task_id）。 */
function currentTurnTask(discussionId: string): string | null {
  const row = db.prepare('SELECT current_turn_task_id FROM discussion WHERE id=?').get(discussionId) as { current_turn_task_id: string | null };
  return row.current_turn_task_id;
}

/** 收集当前排队中的发言 task id（parallel 一轮 = 全部参与者）。 */
function pendingTurnTasks(discussionId: string): string[] {
  const rows = db.prepare(`SELECT id FROM task WHERE input_protocol_json LIKE ? AND state='queued' ORDER BY created_at, id`)
    .all(`%"discussionId":"${discussionId}"%`) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** 模拟一个发言 task 完成。 */
function finishTurn(discussionId: string, taskId: string, content: string): ReturnType<typeof completeDiscussionTurn> {
  db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), taskId);
  return completeDiscussionTurn(db, discussionId, taskId, content);
}

describe('Discussion 并行轮次（阶段七任务 7.3）', () => {
  it('parallel 模式：一轮为所有参与者各建一个发言 task', () => {
    const { lead, writer, designer, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id,
      topic: '如何提升封面点击率',
      participantAgentIds: [lead.id, writer.id, designer.id],
      scenario: 'brainstorm',
      mode: 'parallel',
      maxTurns: 4,
    });
    const started = startDiscussion(db, disc.id);
    // 3 个参与者的发言 task（parallel 一轮 = 全部参与者）
    const turnTasks = db.prepare(`SELECT assignee_agent_id, title FROM task WHERE input_protocol_json LIKE ? AND state='queued'`)
      .all(`%"discussionId":"${disc.id}"%`) as Array<{ assignee_agent_id: string; title: string }>;
    expect(turnTasks.length).toBe(3);
    expect(turnTasks.map((t) => t.assignee_agent_id).sort()).toEqual([lead.id, writer.id, designer.id].sort());
    expect(started.turnTaskId).toBeTruthy();
  });

  it('本轮全部发言完成后创建 synthesis task（moderator 汇总）', () => {
    const { lead, writer, designer, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id,
      topic: '选题讨论',
      participantAgentIds: [lead.id, writer.id, designer.id],
      scenario: 'brainstorm',
      mode: 'parallel',
      maxTurns: 4,
    });
    startDiscussion(db, disc.id);
    // 第一轮 3 个发言 task（parallel 一轮 = 全部参与者）
    const turnTasks = pendingTurnTasks(disc.id);
    expect(turnTasks.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      const result = finishTurn(disc.id, turnTasks[i]!, `发言${i + 1}`);
      if (i < 2) {
        // 前两次发言后：本轮未完成，不产生新 task
        expect(result.nextTurnTaskId).toBeNull();
        expect(getDiscussion(db, disc.id).turnCount).toBe(i + 1);
      } else {
        // 第三次发言完成 → synthesis task 已创建
        const synthTaskId = result.nextTurnTaskId;
        expect(synthTaskId).not.toBeNull();
        const synth = db.prepare('SELECT input_protocol_json FROM task WHERE id=?').get(synthTaskId!) as { input_protocol_json: string };
        const proto = JSON.parse(synth.input_protocol_json);
        expect(proto.synthesis).toBe(true);
        // synthesis 分配给 moderator（第一个参与者 = lead）
        const synthAssignee = db.prepare('SELECT assignee_agent_id FROM task WHERE id=?').get(synthTaskId!) as { assignee_agent_id: string };
        expect(synthAssignee.assignee_agent_id).toBe(lead.id);
      }
    }
  });

  it('synthesis 完成后进入下一轮（再次为所有参与者建发言 task）', () => {
    const { lead, writer, designer, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id,
      topic: '选题讨论',
      participantAgentIds: [lead.id, writer.id, designer.id],
      scenario: 'brainstorm',
      mode: 'parallel',
      maxTurns: 6,
    });
    startDiscussion(db, disc.id);
    // 第一轮 3 个发言
    const firstRound = pendingTurnTasks(disc.id);
    for (let i = 0; i < 3; i++) {
      finishTurn(disc.id, firstRound[i]!, `发言${i + 1}`);
    }
    // synthesis 完成 → 进入第二轮（3 个新发言 task）
    const synthTaskId = currentTurnTask(disc.id)!;
    expect(synthTaskId).not.toBeNull();
    const result = finishTurn(disc.id, synthTaskId, '汇总：大家观点如下…');
    expect(result.nextTurnTaskId).not.toBeNull();
    // 第二轮开始：3 个并行发言 task
    const turnTasks = pendingTurnTasks(disc.id);
    expect(turnTasks.length).toBe(3);
  });

  it('达到 maxTurns 后进入 concluding', () => {
    const { lead, writer, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id,
      topic: '小讨论',
      participantAgentIds: [lead.id, writer.id],
      scenario: 'brainstorm',
      mode: 'parallel',
      maxTurns: 2, // 1 轮（2 人并行）+ 无余量
    });
    startDiscussion(db, disc.id);
    // 2 个发言完成 → 本轮完成且 turnCount(2) >= maxTurns(2) → concluding
    const turnTasks = pendingTurnTasks(disc.id);
    expect(turnTasks.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      finishTurn(disc.id, turnTasks[i]!, `发言${i + 1}`);
    }
    expect(getDiscussion(db, disc.id).state).toBe('concluding');
  });

  it('sequential 模式行为不变（串行轮流发言）', () => {
    const { lead, writer, designer, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id,
      topic: '普通讨论',
      participantAgentIds: [lead.id, writer.id, designer.id],
      scenario: 'brainstorm',
      maxTurns: 6,
    });
    expect(getDiscussion(db, disc.id).mode).toBe('sequential');
    startDiscussion(db, disc.id);
    // 第一轮只创建一个发言 task（串行）
    const turnTasks = pendingTurnTasks(disc.id);
    expect(turnTasks.length).toBe(1);
    // 发言完成 → 下一轮轮到第二个参与者
    const result = finishTurn(disc.id, turnTasks[0]!, '第一轮发言');
    expect(result.nextTurnTaskId).not.toBeNull();
    const nextAssignee = db.prepare('SELECT assignee_agent_id FROM task WHERE id=?').get(result.nextTurnTaskId!) as { assignee_agent_id: string };
    expect(nextAssignee.assignee_agent_id).toBe(writer.id);
  });

  it('start_discussion 工具支持 mode=parallel', async () => {
    const { lead, writer, designer, project } = fixture();
    // 通过工具发起 parallel 讨论
    const parent = createTask(db, {
      projectId: project.id,
      assigneeAgentId: lead.id,
      title: '发起讨论',
    });
    const call: ToolCall = {
      id: 'tc_disc',
      name: 'start_discussion',
      args: {
        topic: '封面设计方向',
        participant_agent_ids: [lead.id, writer.id, designer.id],
        scenario: 'brainstorm',
        mode: 'parallel',
      },
    };
    const ctx = {
      workingDir: '/tmp/worktree',
      readonlyDirs: [],
      toolRegistry: createBuiltinToolRegistry(),
      consultationContext: { db, askerTaskId: parent.id, askerProjectId: project.id, askerProjectTaskId: parent.projectTaskId, askerAgentId: lead.id },
    };
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('已创建讨论室');
    const discId = db.prepare("SELECT id FROM discussion ORDER BY created_at DESC LIMIT 1").get() as { id: string };
    expect(getDiscussion(db, discId.id).mode).toBe('parallel');
    // 第一轮已为所有参与者建发言 task
    expect(pendingTurnTasks(discId.id).length).toBe(3);
    void listParticipants;
  });
});
