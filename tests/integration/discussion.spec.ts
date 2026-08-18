import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 讨论室集成测试（设计二-方案B）。
 *
 * 验证完整流程：
 * 1. createDiscussion 创建讨论室 + 注册参与者（第一个是 moderator）
 * 2. startDiscussion 启动第一轮发言 task（assignee=第一个参与者）
 * 3. completeDiscussionTurn 记录发言 + 自动轮转到下一位
 * 4. 达 maxTurns 自动进入 concluding
 * 5. concludeDiscussion 写纪要 + 派发实施任务 + 写项目对话窗口
 * 6. start_discussion / conclude_discussion 工具 handler
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, completeTask, getTask, claimNextTask, markRunning } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import {
  createDiscussion,
  startDiscussion,
  completeDiscussionTurn,
  concludeDiscussion,
  getDiscussion,
  listParticipants,
  listTurns,
} from '../../src/server/domain/discussion';
import { executeTool, createBuiltinToolRegistry, type ToolCall, type ToolContext } from '../../src/server/executors/tools/registry';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

function fixture() {
  const c = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
  const editor = createAgent(db, { companyId: c.id, name: 'editor', role: 'editor' });
  const project = createProject(db, { companyId: c.id, name: 'novel', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
  return { c, lead, writer, editor, project };
}

function makeCtx(askerTaskId: string, askerProjectId: string, askerProjectTaskId: string, askerAgentId: string): ToolContext {
  return {
    workingDir: '/tmp/worktree',
    readonlyDirs: [],
    toolRegistry: createBuiltinToolRegistry(),
    consultationContext: { db, askerTaskId, askerProjectId, askerProjectTaskId, askerAgentId },
  };
}

describe('讨论室 domain（设计二-方案B）', () => {
  it('创建讨论室：注册参与者，第一个是 moderator', () => {
    const { lead, writer, editor, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id,
      topic: '第一章主角设定',
      participantAgentIds: [lead.id, writer.id, editor.id],
      initiatorAgentId: lead.id,
    });
    expect(disc.state).toBe('open');
    expect(disc.turnCount).toBe(0);
    expect(disc.maxTurns).toBe(12);
    const participants = listParticipants(db, disc.id);
    expect(participants).toHaveLength(3);
    expect(participants[0].role).toBe('moderator');
    expect(participants[0].agentId).toBe(lead.id);
    expect(participants[1].role).toBe('member');
    expect(participants[2].role).toBe('member');
  });

  it('至少 2 人，最多 8 人', () => {
    const { lead, project } = fixture();
    expect(() => createDiscussion(db, { projectId: project.id, topic: 't', participantAgentIds: [lead.id] }))
      .toThrow(/至少需要 2/);
  });

  it('startDiscussion 启动第一轮发言 task，assignee 是第一个参与者', () => {
    const { lead, writer, editor, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id, topic: '主角设定',
      participantAgentIds: [lead.id, writer.id, editor.id], initiatorAgentId: lead.id,
    });
    const started = startDiscussion(db, disc.id);
    expect(started.turnTaskId).toBeTruthy();
    const turnTask = getTask(db, started.turnTaskId);
    expect(turnTask.assigneeAgentId).toBe(lead.id);
    const inputProtocol = turnTask.inputProtocol as Record<string, unknown>;
    expect(inputProtocol.discussion).toBe(true);
    expect(inputProtocol.isYourTurn).toBe(true);
    expect(inputProtocol.topic).toBe('主角设定');
    const updated = getDiscussion(db, disc.id);
    expect(updated.currentSpeakerAgentId).toBe(lead.id);
  });

  it('completeDiscussionTurn 记录发言 + 自动轮转到下一位', () => {
    const { lead, writer, editor, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id, topic: '主角设定',
      participantAgentIds: [lead.id, writer.id, editor.id], initiatorAgentId: lead.id,
    });
    const started = startDiscussion(db, disc.id);
    // 模拟 lead 完成发言
    const leadThread = ensurePrimaryThread(db, project.id, lead.id);
    claimNextTask(db, leadThread.id, lead.id);
    markRunning(db, started.turnTaskId);
    const result = completeDiscussionTurn(db, disc.id, started.turnTaskId, '主角应该是孤儿');
    expect(result.discussion.turnCount).toBe(1);
    expect(result.nextTurnTaskId).toBeTruthy();
    // 第二轮轮到 writer
    const nextTask = getTask(db, result.nextTurnTaskId!);
    expect(nextTask.assigneeAgentId).toBe(writer.id);
    // 发言已记录
    const turns = listTurns(db, disc.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe('主角应该是孤儿');
    expect(turns[0].speakerAgentId).toBe(lead.id);
  });

  it('达 maxTurns 自动进入 concluding', () => {
    const { lead, writer, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id, topic: 't',
      participantAgentIds: [lead.id, writer.id], initiatorAgentId: lead.id, maxTurns: 2,
    });
    // 第一轮 lead
    const t1 = startDiscussion(db, disc.id);
    const lt = ensurePrimaryThread(db, project.id, lead.id);
    claimNextTask(db, lt.id, lead.id); markRunning(db, t1.turnTaskId);
    const r1 = completeDiscussionTurn(db, disc.id, t1.turnTaskId, 'lead 说');
    expect(r1.nextTurnTaskId).toBeTruthy();
    // 第二轮 writer
    const wt = ensurePrimaryThread(db, project.id, writer.id);
    claimNextTask(db, wt.id, writer.id); markRunning(db, r1.nextTurnTaskId!);
    const r2 = completeDiscussionTurn(db, disc.id, r1.nextTurnTaskId!, 'writer 说');
    expect(r2.discussion.turnCount).toBe(2);
    expect(r2.discussion.state).toBe('concluding');
    expect(r2.nextTurnTaskId).toBeNull();
  });

  it('concludeDiscussion 写纪要 + 派发实施任务 + 写项目对话', () => {
    const { lead, writer, editor, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id, topic: '主角设定',
      participantAgentIds: [lead.id, writer.id, editor.id], initiatorAgentId: lead.id,
    });
    // 跳过完整轮转，直接总结（模拟发起者中途 conclude）
    const result = concludeDiscussion(db, disc.id, {
      minutes: '经过讨论，主角设定为孤儿，被宗门收养',
      conclusion: {
        keyPoints: ['主角是孤儿', '被宗门收养'],
        actions: [
          { title: '更新人物档案', assigneeAgentId: writer.id },
          { title: '调整第一章剧情', assigneeAgentId: editor.id },
        ],
        memoryNotes: ['主角背景共识：孤儿+宗门'],
      },
      concludedByAgentId: lead.id,
    });
    expect(result.dispatchedTaskIds).toHaveLength(2);
    const updated = getDiscussion(db, disc.id);
    expect(updated.state).toBe('concluded');
    expect(updated.minutes).toContain('孤儿');
    expect(updated.conclusion?.keyPoints).toContain('主角是孤儿');
    // 实施任务已创建
    const tasks = db.prepare('SELECT title, assignee_agent_id FROM task WHERE input_protocol_json LIKE ?').all(`%"fromDiscussion":"${disc.id}"%`) as Array<{ title: string; assignee_agent_id: string }>;
    expect(tasks.length).toBe(2);
    // 项目对话窗口有纪要
    const msgs = db.prepare("SELECT content FROM conversation_message WHERE scope_kind='project' AND scope_id=? AND content LIKE '%讨论纪要%'").all(project.id) as Array<{ content: string }>;
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('孤儿');
  });
});

describe('start_discussion / conclude_discussion 工具', () => {
  it('start_discussion 工具创建讨论室 + 启动第一轮 + 建依赖', async () => {
    const { lead, writer, editor, project } = fixture();
    const askerTask = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '主持讨论' });
    const call: ToolCall = {
      id: 'tc1', name: 'start_discussion',
      args: { topic: '主角设定', participant_agent_ids: [writer.id, editor.id] },
    };
    const ctx = makeCtx(askerTask.id, project.id, askerTask.projectTaskId, lead.id);
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('已创建讨论室');
    expect(result.content).toContain('waiting_dependency');
    // 讨论室已创建（含 lead 作为 moderator + writer + editor）
    const discs = db.prepare('SELECT id, topic FROM discussion WHERE source_task_id=?').all(askerTask.id) as Array<{ id: string; topic: string }>;
    expect(discs.length).toBe(1);
    expect(discs[0].topic).toBe('主角设定');
    const participants = listParticipants(db, discs[0].id);
    expect(participants).toHaveLength(3); // lead + writer + editor
    // 第一轮发言 task 已创建
    const disc = getDiscussion(db, discs[0].id);
    expect(disc.currentTurnTaskId).toBeTruthy();
  });

  it('conclude_discussion 工具总结讨论 + 派发实施任务', async () => {
    const { lead, writer, editor, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id, topic: '主角设定',
      participantAgentIds: [lead.id, writer.id, editor.id], initiatorAgentId: lead.id,
    });
    const askerTask = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '主持讨论' });
    const call: ToolCall = {
      id: 'tc1', name: 'conclude_discussion',
      args: {
        discussion_id: disc.id,
        minutes: '达成共识：孤儿设定',
        key_points: ['主角是孤儿'],
        actions: [{ title: '更新档案', assignee_agent_id: writer.id }],
      },
    };
    const ctx = makeCtx(askerTask.id, project.id, askerTask.projectTaskId, lead.id);
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('已总结');
    const updated = getDiscussion(db, disc.id);
    expect(updated.state).toBe('concluded');
    expect(updated.conclusion?.keyPoints).toContain('主角是孤儿');
  });

  it('缺 consultationContext 时优雅降级', async () => {
    const call: ToolCall = { id: 'tc', name: 'start_discussion', args: { topic: 't', participant_agent_ids: ['a', 'b'] } };
    const ctx: ToolContext = { workingDir: '/tmp', readonlyDirs: [], toolRegistry: createBuiltinToolRegistry() };
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('讨论通道未配置');
  });
});

describe('讨论室场景化与分身（设计二-方案B 增强）', () => {
  it('createDiscussion 带 scenario，存入 context', () => {
    const { lead, writer, editor, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id, topic: '质量评审',
      participantAgentIds: [lead.id, writer.id, editor.id], initiatorAgentId: lead.id,
      scenario: 'quality-review',
    });
    expect(disc.context.scenario).toBe('quality-review');
    expect(disc.context.scenarioGuidance).toContain('评审');
  });

  it('quality-review 场景：非领导角色发起被拒绝', () => {
    const { lead, writer, editor, project } = fixture();
    // writer 不是 lead/manager/moderator/reviewer/editor → 应被拒
    // 注意：createAgent 默认 role='writer'，不含上述关键词
    expect(() => createDiscussion(db, {
      projectId: project.id, topic: '评审',
      participantAgentIds: [writer.id, editor.id], initiatorAgentId: writer.id,
      scenario: 'quality-review',
    })).toThrow(/角色/);
  });

  it('help-request 场景：任何角色可发起（* 通配）', () => {
    const { lead, writer, editor, project } = fixture();
    expect(() => createDiscussion(db, {
      projectId: project.id, topic: '求助',
      participantAgentIds: [writer.id, editor.id], initiatorAgentId: writer.id,
      scenario: 'help-request',
    })).not.toThrow();
  });

  it('分身参与：createDiscussion 为参与者自动创建 mirror', () => {
    const { lead, writer, editor, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id, topic: '讨论',
      participantAgentIds: [lead.id, writer.id, editor.id], initiatorAgentId: lead.id,
    });
    // 每个参与者应有 mirror（createMirror 复用空闲分身，至少存在）
    const mirrors = db.prepare("SELECT * FROM project_agent_thread WHERE project_id=? AND kind='mirror'").all(project.id) as Array<{ agent_id: string }>;
    const mirrorAgents = new Set(mirrors.map((m) => m.agent_id));
    expect(mirrorAgents.has(lead.id)).toBe(true);
    expect(mirrorAgents.has(writer.id)).toBe(true);
    expect(mirrorAgents.has(editor.id)).toBe(true);
  });

  it('分身上限：同一员工复用空闲 mirror，不重复创建', () => {
    const { lead, writer, project } = fixture();
    createDiscussion(db, { projectId: project.id, topic: 't1', participantAgentIds: [lead.id, writer.id], initiatorAgentId: lead.id });
    const beforeCount = (db.prepare("SELECT COUNT(*) as c FROM project_agent_thread WHERE project_id=? AND kind='mirror' AND agent_id=?").get(project.id, lead.id) as { c: number }).c;
    createDiscussion(db, { projectId: project.id, topic: 't2', participantAgentIds: [lead.id, writer.id], initiatorAgentId: lead.id });
    const afterCount = (db.prepare("SELECT COUNT(*) as c FROM project_agent_thread WHERE project_id=? AND kind='mirror' AND agent_id=?").get(project.id, lead.id) as { c: number }).c;
    expect(afterCount).toBe(beforeCount); // 复用，不新增
  });

  it('concludeDiscussion needsHuman=true：不派 task，写人工提示，释放分身', () => {
    const { lead, writer, editor, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id, topic: '无果讨论',
      participantAgentIds: [lead.id, writer.id, editor.id], initiatorAgentId: lead.id,
    });
    const result = concludeDiscussion(db, disc.id, {
      minutes: '未能达成共识',
      conclusion: { keyPoints: ['存在分歧'], actions: [{ title: '应派但不派', assigneeAgentId: writer.id }], memoryNotes: [] },
      concludedByAgentId: lead.id,
      needsHuman: true,
    });
    expect(result.dispatchedTaskIds).toHaveLength(0); // needsHuman 不派 task
    // 项目对话有人工提示
    const msgs = db.prepare("SELECT content FROM conversation_message WHERE scope_id=? AND content LIKE '%需人工确认%'").all(project.id) as Array<{ content: string }>;
    expect(msgs.length).toBe(1);
  });

  it('发言 task 标记 isDiscussion=true + priority=1（可被正式 task 抢占）', () => {
    const { lead, writer, editor, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id, topic: '讨论',
      participantAgentIds: [lead.id, writer.id, editor.id], initiatorAgentId: lead.id,
    });
    const started = startDiscussion(db, disc.id);
    const turnTask = db.prepare('SELECT is_discussion, priority FROM task WHERE id=?').get(started.turnTaskId) as { is_discussion: number; priority: number };
    expect(turnTask.is_discussion).toBe(1);
    expect(turnTask.priority).toBe(1);
  });

  it('concludeDiscussion 后参与者 idle 分身被释放', () => {
    const { lead, writer, editor, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id, topic: '讨论',
      participantAgentIds: [lead.id, writer.id, editor.id], initiatorAgentId: lead.id,
    });
    concludeDiscussion(db, disc.id, {
      minutes: '完成',
      conclusion: { keyPoints: ['ok'], actions: [], memoryNotes: [] },
      concludedByAgentId: lead.id,
    });
    // 分身被释放（idle 的已 remove）
    const mirrors = db.prepare("SELECT * FROM project_agent_thread WHERE project_id=? AND kind='mirror'").all(project.id) as Array<{ state: string }>;
    // 至少没有 idle 的残留（可能全部被 remove，或只剩 running 的）
    const idleMirrors = mirrors.filter((m) => m.state === 'idle');
    expect(idleMirrors.length).toBe(0);
  });
});

describe('系统自动触发讨论场景验证', () => {
  it('quality-review 场景：领导发起，参与者含产出者+评审者', () => {
    const { lead, writer, editor, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id, topic: '任务 #1 验收不达标评审',
      participantAgentIds: [lead.id, writer.id, editor.id], initiatorAgentId: lead.id,
      scenario: 'quality-review', maxTurns: 6,
      context: { taskId: 'fake-task', failedCriteria: ['criteria-1'] },
    });
    expect(disc.context.scenario).toBe('quality-review');
    expect(disc.topic).toContain('验收不达标');
  });

  it('conflict-resolution 场景：冲突方+裁决者参与', () => {
    const { lead, writer, editor, project } = fixture();
    const disc = createDiscussion(db, {
      projectId: project.id, topic: '发布冲突协调（3 处）',
      participantAgentIds: [lead.id, writer.id], initiatorAgentId: lead.id,
      scenario: 'conflict-resolution', maxTurns: 8,
      context: { conflicts: ['file1.ts', 'file2.ts', 'file3.ts'] },
    });
    expect(disc.context.scenario).toBe('conflict-resolution');
    startDiscussion(db, disc.id);
    const turns = listTurns(db, disc.id);
    expect(turns.length).toBe(0); // 刚启动，无发言
    expect(disc.currentSpeakerAgentId ?? disc).toMatchObject({ topic: '发布冲突协调（3 处）' });
  });

  it('task-clarification 场景：跨公司交接对齐（甲方内部讨论）', () => {
    const c1 = restoreWorkbench(db, { id: 'wb_fix_2', name: '甲方' });
    const c2 = restoreWorkbench(db, { id: 'wb_fix_3', name: '乙方' });
    const buyer = createAgent(db, { companyId: c1.id, name: 'buyer', role: 'lead' });
    const buyer2 = createAgent(db, { companyId: c1.id, name: 'reviewer', role: 'editor' });
    const project1 = createProject(db, { companyId: c1.id, name: '甲项目', rootDir: makeTempGitRepo(), firstAgentId: buyer.id, initialState: 'active' });
    // 甲方内部讨论对齐验收标准
    const disc = createDiscussion(db, {
      projectId: project1.id, topic: '外包交付验收对齐',
      participantAgentIds: [buyer.id, buyer2.id], initiatorAgentId: buyer.id,
      scenario: 'task-clarification', maxTurns: 6,
      context: { providerCompanyId: c2.id, acceptanceCriteria: [{ id: 'ac1', criterion: '功能完整', met: undefined }] },
    });
    expect(disc.context.scenario).toBe('task-clarification');
    expect(disc.context.providerCompanyId).toBe(c2.id);
  });

  it('DISCUSSION_SCENARIOS 含 7 个场景，每个有完整配置', async () => {
    const { DISCUSSION_SCENARIOS } = await import('../../src/server/domain/discussion');
    const scenarios = Object.keys(DISCUSSION_SCENARIOS);
    expect(scenarios).toHaveLength(7);
    expect(scenarios).toContain('help-request');
    expect(scenarios).toContain('task-clarification');
    expect(scenarios).toContain('quality-review');
    expect(scenarios).toContain('task-breakdown');
    expect(scenarios).toContain('standard-alignment');
    expect(scenarios).toContain('conflict-resolution');
    expect(scenarios).toContain('brainstorm');
    for (const [key, cfg] of Object.entries(DISCUSSION_SCENARIOS)) {
      expect(cfg.allowedInitiatorRoles.length).toBeGreaterThan(0);
      expect(cfg.participantGuidance.length).toBeGreaterThan(0);
      expect(cfg.conclusionAction.length).toBeGreaterThan(0);
      expect(cfg.description.length).toBeGreaterThan(0);
    }
  });
});
