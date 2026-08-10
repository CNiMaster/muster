/**
 * ask_colleague 咨询工具集成测试（设计二-方案A）。
 *
 * 验证：
 * 1. ask_colleague handler 创建咨询 Task（assignee=被咨询者）+ 建依赖
 * 2. 咨询任务 completed 时回复写回父任务 task_message（role='dispatch'）
 * 3. 父任务自动从 waiting_dependency 恢复为 queued
 * 4. 同公司校验、自我咨询校验
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { getDb, setDbForTest } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, completeTask, getTask, claimNextTask, markRunning } from '../../src/server/domain/task';
import { listTaskMessages } from '../../src/server/domain/task-message';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
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

function makeConsultationContext(askerTaskId: string, askerProjectId: string, askerProjectTaskId: string, askerAgentId: string): ToolContext {
  return {
    workingDir: '/tmp/worktree',
    readonlyDirs: [],
    toolRegistry: createBuiltinToolRegistry(),
    consultationContext: { db, askerTaskId, askerProjectId, askerProjectTaskId, askerAgentId },
  };
}

describe('ask_colleague 工具（设计二-方案A）', () => {
  it('创建咨询 Task，建依赖，返回提示让模型以 waiting_dependency 收尾', async () => {
    const { lead, writer, project } = fixture();
    const askerTask = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: '写第1章' });
    const call: ToolCall = {
      id: 'tc_1',
      name: 'ask_colleague',
      args: { recipient_agent_id: lead.id, question: '主角的背景故事应该怎么设定？' },
    };
    const ctx = makeConsultationContext(askerTask.id, project.id, askerTask.projectTaskId, writer.id);
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('已向 lead');
    expect(result.content).toContain('waiting_dependency');
    // 咨询 Task 已创建并分配给 lead
    const tasks = db.prepare('SELECT * FROM task WHERE parent_task_id=?').all(askerTask.id) as Array<{ assignee_agent_id: string; title: string; input_protocol_json: string }>;
    expect(tasks.length).toBe(1);
    expect(tasks[0].assignee_agent_id).toBe(lead.id);
    const inputProtocol = JSON.parse(tasks[0].input_protocol_json);
    expect(inputProtocol.consultation).toBe(true);
    expect(inputProtocol.question).toBe('主角的背景故事应该怎么设定？');
  });

  it('咨询任务完成时回复写回父任务 task_message，父任务恢复为 queued', async () => {
    const { lead, writer, project } = fixture();
    const askerTask = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: '写第1章' });
    // 模拟 writer 执行中调用 ask_colleague
    const call: ToolCall = {
      id: 'tc_1',
      name: 'ask_colleague',
      args: { recipient_agent_id: lead.id, question: '主角背景？' },
    };
    const ctx = makeConsultationContext(askerTask.id, project.id, askerTask.projectTaskId, writer.id);
    await executeTool(call, ctx);
    // 取出咨询 Task
    const consultationTaskRow = db.prepare('SELECT id FROM task WHERE parent_task_id=?').get(askerTask.id) as { id: string };
    // 模拟 writer 以 waiting_dependency 结束（ask_colleague 提示要求如此）
    markRunningCompleteWaitingDep(db, askerTask.id);
    expect(getTask(db, askerTask.id).state).toBe('waiting_dependency');
    // lead 领取并完成咨询任务，回复写在 summary
    const leadThread = ensurePrimaryThread(db, project.id, lead.id);
    const claimed = claimNextTask(db, leadThread.id, lead.id);
    expect(claimed?.task.id).toBe(consultationTaskRow.id);
    markRunning(db, consultationTaskRow.id);
    completeTask(db, consultationTaskRow.id, { outcome: 'completed', summary: '主角背景：孤儿，被武林宗门收养。', outboundTasks: [], artifacts: [] });
    // 父任务自动恢复为 queued
    expect(getTask(db, askerTask.id).state).toBe('queued');
    // 回复已写回父任务的 task_message（role='dispatch'）
    const msgs = listTaskMessages(db, askerTask.id);
    const replyMsg = msgs.find((m) => m.role === 'dispatch' && m.content.includes('咨询回复'));
    expect(replyMsg).toBeDefined();
    expect(replyMsg!.content).toContain('孤儿，被武林宗门收养');
  });

  it('跨公司咨询被拒绝', async () => {
    const c1 = createCompany(db, { name: 'co1' });
    const c2 = createCompany(db, { name: 'co2' });
    const w1 = createAgent(db, { companyId: c1.id, name: 'w1', role: 'writer' });
    const w2 = createAgent(db, { companyId: c2.id, name: 'w2', role: 'writer' });
    const project = createProject(db, { companyId: c1.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: w1.id, initialState: 'active' });
    const askerTask = createTask(db, { projectId: project.id, assigneeAgentId: w1.id, title: 't' });
    const call: ToolCall = { id: 'tc', name: 'ask_colleague', args: { recipient_agent_id: w2.id, question: 'q' } };
    const ctx = makeConsultationContext(askerTask.id, project.id, askerTask.projectTaskId, w1.id);
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('不属于本公司');
  });

  it('自我咨询被拒绝', async () => {
    const { writer, project } = fixture();
    const askerTask = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: 't' });
    const call: ToolCall = { id: 'tc', name: 'ask_colleague', args: { recipient_agent_id: writer.id, question: 'q' } };
    const ctx = makeConsultationContext(askerTask.id, project.id, askerTask.projectTaskId, writer.id);
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('不能向自己发起咨询');
  });

  it('缺 consultationContext 时优雅降级', async () => {
    const call: ToolCall = { id: 'tc', name: 'ask_colleague', args: { recipient_agent_id: 'x', question: 'q' } };
    const ctx: ToolContext = { workingDir: '/tmp', readonlyDirs: [], toolRegistry: createBuiltinToolRegistry() };
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('咨询通道未配置');
  });
});

/** 辅助：模拟 writer 以 waiting_dependency 结束当前 task（绕过 claim 流程，直接改状态）。 */
function markRunningCompleteWaitingDep(db: DB, taskId: string): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE task SET state='waiting_dependency', outcome='waiting_dependency', updated_at=? WHERE id=?").run(now, taskId);
}
