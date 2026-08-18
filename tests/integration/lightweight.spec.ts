/**
 * 轻量化测试（agent 间交互轻量化三件套）。
 *
 * 1. notify_colleague：单向告知，写 task_message 不建 task
 * 2. ask_colleague / 讨论发言 task 带 lightweight 标记
 * 3. lightweight 上下文：不含技能/素材/记忆/验收段，含议题/职责/契约
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask } from '../../src/server/domain/task';
import { listTaskMessages } from '../../src/server/domain/task-message';
import { assembleContext } from '../../src/server/executors/context';
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
  const c = createCompany(db, { name: 'co' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
  const project = createProject(db, { companyId: c.id, name: 'novel', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
  return { c, lead, writer, project };
}

function makeCtx(askerTaskId: string, askerProjectId: string, askerProjectTaskId: string, askerAgentId: string): ToolContext {
  return {
    workingDir: '/tmp/worktree',
    readonlyDirs: [],
    toolRegistry: createBuiltinToolRegistry(),
    consultationContext: { db, askerTaskId, askerProjectId, askerProjectTaskId, askerAgentId },
  };
}

describe('notify_colleague（轻量化-3）', () => {
  it('单向告知：写对方活跃 task 的 task_message，不建新 task', async () => {
    const { lead, writer, project } = fixture();
    // writer 有活跃 task
    const writerTask = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: 'writer 在写' });
    const askerTask = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: 'lead 通知' });
    const call: ToolCall = { id: 'tc1', name: 'notify_colleague', args: { recipient_agent_id: writer.id, message: '我已完成初稿，你可以开始评审' } };
    const ctx = makeCtx(askerTask.id, project.id, askerTask.projectTaskId, lead.id);
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('已通知 writer');
    // writer 的活跃 task 收到 dispatch 通知
    const msgs = listTaskMessages(db, writerTask.id);
    const notice = msgs.find((m) => m.role === 'dispatch' && m.content.includes('[通知]'));
    expect(notice).toBeDefined();
    expect(notice!.content).toContain('我已完成初稿');
    // 没有创建新 task（咨询会建，通知不建）
    const allTasks = db.prepare('SELECT COUNT(*) as c FROM task').get() as { c: number };
    expect(allTasks.c).toBe(2); // 只有 writerTask + askerTask
  });

  it('接收方无活跃 task：通知写到其最近 task 不丢', async () => {
    const { lead, writer, project } = fixture();
    // writer 只有已完成 task（无活跃）
    const done = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: '已完成' });
    db.prepare("UPDATE task SET state='completed', updated_at=? WHERE id=?").run(new Date().toISOString(), done.id);
    const askerTask = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: 'lead 通知' });
    const call: ToolCall = { id: 'tc1', name: 'notify_colleague', args: { recipient_agent_id: writer.id, message: '有空看看我的稿子' } };
    const ctx = makeCtx(askerTask.id, project.id, askerTask.projectTaskId, lead.id);
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('已通知 writer');
    const msgs = listTaskMessages(db, done.id);
    expect(msgs.some((m) => m.content.includes('[通知]') && m.content.includes('稿子'))).toBe(true);
  });

  it('接收方从未有 task（新员工）：通知写入公司对话流不丢', async () => {
    const { lead, project } = fixture();
    // 新员工：有 agent 但从无 task
    const { createAgent: createAgent2 } = await import('../../src/server/domain/agent');
    const newbie = createAgent2(db, { companyId: project.companyId, name: 'newbie', role: 'writer' });
    const askerTask = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: 'lead 通知' });
    const call: ToolCall = { id: 'tc1', name: 'notify_colleague', args: { recipient_agent_id: newbie.id, message: '欢迎入职' } };
    const ctx = makeCtx(askerTask.id, project.id, askerTask.projectTaskId, lead.id);
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('已通知 newbie');
    // 公司对话流有通知
    const companyMsgs = db.prepare("SELECT content FROM conversation_message WHERE scope_kind='workbench' AND content LIKE '%员工通知%'").all() as Array<{ content: string }>;
    expect(companyMsgs.length).toBe(1);
    expect(companyMsgs[0].content).toContain('欢迎入职');
  });

  it('跨公司通知被接受（公司退役批次D：agent 归属单例工作台，通知不再限公司）', async () => {
    const c2 = createCompany(db, { name: 'co2' });
    const outsider = createAgent(db, { companyId: c2.id, name: 'out', role: 'x' });
    const { lead, project } = fixture();
    const askerTask = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: 't' });
    const call: ToolCall = { id: 'tc', name: 'notify_colleague', args: { recipient_agent_id: outsider.id, message: 'hi' } };
    const ctx = makeCtx(askerTask.id, project.id, askerTask.projectTaskId, lead.id);
    const result = await executeTool(call, ctx);
    // 单例工作台下所有员工同属一个工作台，通知成功
    expect(result.content).toContain('已通知 out');
  });

  it('缺 consultationContext 时优雅降级', async () => {
    const call: ToolCall = { id: 'tc', name: 'notify_colleague', args: { recipient_agent_id: 'x', message: 'hi' } };
    const ctx: ToolContext = { workingDir: '/tmp', readonlyDirs: [], toolRegistry: createBuiltinToolRegistry() };
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('通知通道未配置');
  });
});

describe('lightweight 标记与产物约束（轻量化-2）', () => {
  it('ask_colleague 创建的咨询 task 带 lightweight 标记', async () => {
    const { lead, writer, project } = fixture();
    const askerTask = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: '写' });
    const call: ToolCall = { id: 'tc1', name: 'ask_colleague', args: { recipient_agent_id: lead.id, question: '主角背景？' } };
    const ctx = makeCtx(askerTask.id, project.id, askerTask.projectTaskId, writer.id);
    await executeTool(call, ctx);
    const consultationRow = db.prepare('SELECT id FROM task WHERE parent_task_id=?').get(askerTask.id) as { id: string };
    const consultation = getTask(db, consultationRow.id);
    expect((consultation.inputProtocol as Record<string, unknown>).lightweight).toBe(true);
  });

  it('讨论发言 task 带 lightweight 标记', async () => {
    const { createDiscussion, startDiscussion } = await import('../../src/server/domain/discussion');
    const { lead, writer, project } = fixture();
    const disc = createDiscussion(db, { projectId: project.id, topic: 't', participantAgentIds: [lead.id, writer.id], initiatorAgentId: lead.id });
    const started = startDiscussion(db, disc.id);
    const turnTask = getTask(db, started.turnTaskId);
    expect((turnTask.inputProtocol as Record<string, unknown>).lightweight).toBe(true);
  });
});

describe('lightweight 上下文装配（轻量化-1）', () => {
  it('lightweight 模式：含职责/议题/契约，不含技能/素材/记忆/验收段', async () => {
    const { lead, writer, project } = fixture();
    const task = createTask(db, {
      projectId: project.id, assigneeAgentId: writer.id, title: '咨询测试',
      inputProtocol: { lightweight: true, consultation: true, instruction: '同事 lead 咨询：主角背景怎么设定？', question: '主角背景怎么设定？' },
    });
    const assembled = assembleContext(db, task, { lightweight: true });
    // 含轻量必备段
    expect(assembled.systemPrompt).toContain('# 员工身份');
    expect(assembled.systemPrompt).toContain('# 你的职责');
    expect(assembled.systemPrompt).toContain('# 本任务说明');
    expect(assembled.systemPrompt).toContain('# 待答复问题');
    expect(assembled.systemPrompt).toContain('# 输出契约');
    // 不含大段上下文（注意：# 输出契约里的"对照 # 验收标准 的 id"是契约指引，用完整段名判断）
    expect(assembled.systemPrompt).not.toContain('# 项目素材');
    expect(assembled.systemPrompt).not.toContain('# 本 Task 按需加载的 Skill');
    expect(assembled.systemPrompt).not.toContain('# 已批准的相关记忆');
    expect(assembled.systemPrompt).not.toContain('这是本任务"什么算好结果"的判定依据');
    expect(assembled.systemPrompt).not.toContain('# 项目说明');
    expect(assembled.systemPrompt).not.toContain('# 公司章程');
    // inputPacket 无 referencedArtifacts 全量
    expect(assembled.inputPacket.referencedArtifacts).toEqual({});
  });

  it('非 lightweight 模式：保留完整上下文（回归）', async () => {
    const { lead, writer, project } = fixture();
    const task = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: '正式任务' });
    const assembled = assembleContext(db, task, {});
    expect(assembled.systemPrompt).toContain('# 项目说明');
    expect(assembled.systemPrompt).toContain('# 输出契约');
  });
});
