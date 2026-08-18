import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 子任务失败兜底（阶段一任务 1.1）集成测试。
 *
 * 验证：
 * 1. 子任务 failTask 后，父任务（waiting_dependency）收到失败通知消息
 * 2. 第一负责人收到 [兜底] 子任务失败 上报 Task
 * 3. 去重：同一父任务多次子任务失败不重复派发 [兜底]
 * 4. 取消失败子任务（cancelTask）后父任务恢复 queued（cancelled 依赖视为已处理）
 * 5. cancel_child_task 工具：权限校验、跨项目拒绝、取消后唤醒
 * 6. 状态机：failed → cancelled 合法
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import {
  createTask,
  completeTask,
  getTask,
  failTask,
  cancelTask,
  addDependency,
  areDependenciesMet,
  resumeDependents,
} from '../../src/server/domain/task';
import { listTaskMessages } from '../../src/server/domain/task-message';
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
  const worker = createAgent(db, { companyId: c.id, name: 'worker', role: 'worker' });
  const project = createProject(db, {
    companyId: c.id,
    name: 'p',
    rootDir: makeTempGitRepo(),
    firstAgentId: lead.id,
    initialState: 'active',
  });
  return { c, lead, worker, project };
}

/** 辅助：模拟父任务以 waiting_dependency 结束并依赖 child。 */
function makeParentWaitingOnChild(parentId: string, childId: string): void {
  addDependency(db, parentId, childId);
  const now = new Date().toISOString();
  db.prepare("UPDATE task SET state='waiting_dependency', outcome='waiting_dependency', updated_at=? WHERE id=?").run(now, parentId);
}

describe('子任务失败兜底（阶段一任务 1.1）', () => {
  it('子任务失败后父任务收到失败通知，第一负责人收到 [兜底] Task', () => {
    const { lead, worker, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '父任务：写一章' });
    const child = createTask(db, {
      projectId: project.id,
      parentTaskId: parent.id,
      assigneeAgentId: worker.id,
      title: '子任务：查资料',
    });
    makeParentWaitingOnChild(parent.id, child.id);

    failTask(db, child.id, '执行异常：网络超时');

    // 1. 父任务仍在 waiting_dependency（不自动恢复，等待负责人决策）
    expect(getTask(db, parent.id).state).toBe('waiting_dependency');
    // 2. 父任务收到失败通知
    const msgs = listTaskMessages(db, parent.id);
    const failMsg = msgs.find((m) => m.role === 'dispatch' && m.content.includes('子任务失败'));
    expect(failMsg).toBeDefined();
    expect(failMsg!.content).toContain('网络超时');
    // 3. 第一负责人收到 [兜底] Task
    const bailouts = db
      .prepare(`SELECT * FROM task WHERE assignee_agent_id=? AND title LIKE '[兜底]%'`)
      .all(lead.id) as Array<{ state: string; input_protocol_json: string; priority: number }>;
    expect(bailouts.length).toBe(1);
    expect(bailouts[0].priority).toBe(8);
    const inputProtocol = JSON.parse(bailouts[0].input_protocol_json);
    expect(inputProtocol.reason).toBe('child_task_failed');
    expect(inputProtocol.failedChildTaskId).toBe(child.id);
  });

  it('去重：同一父任务再次子任务失败不重复派 [兜底] Task，但消息仍写入', () => {
    const { lead, worker, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '父任务' });
    const child1 = createTask(db, { projectId: project.id, parentTaskId: parent.id, assigneeAgentId: worker.id, title: '子1' });
    const child2 = createTask(db, { projectId: project.id, parentTaskId: parent.id, assigneeAgentId: worker.id, title: '子2' });
    makeParentWaitingOnChild(parent.id, child1.id);
    makeParentWaitingOnChild(parent.id, child2.id);

    failTask(db, child1.id, '失败1');
    failTask(db, child2.id, '失败2');

    const bailouts = db
      .prepare(`SELECT * FROM task WHERE assignee_agent_id=? AND title LIKE '[兜底]%'`)
      .all(lead.id) as Array<{ id: string }>;
    expect(bailouts.length).toBe(1);
    const msgs = listTaskMessages(db, parent.id);
    const failMsgs = msgs.filter((m) => m.content.includes('子任务失败'));
    expect(failMsgs.length).toBe(2); // 两次失败都写消息，但只派一次兜底
    // Review 修复：第二次失败的信息被追加进现有 [兜底] 任务的 failedChildren
    const bailout = db.prepare('SELECT input_protocol_json FROM task WHERE id=?').get(bailouts[0]!.id) as { input_protocol_json: string };
    const proto = JSON.parse(bailout.input_protocol_json);
    expect(Array.isArray(proto.failedChildren)).toBe(true);
    expect(proto.failedChildren.length).toBe(1); // 第二次失败追加了 1 条
    expect(proto.failedChildren[0]!.failedChildTaskId).toBe(child2.id);
  });

  it('取消失败子任务后父任务恢复 queued（cancelled 依赖视为已处理）', () => {
    const { worker, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '父任务' });
    const child = createTask(db, { projectId: project.id, parentTaskId: parent.id, assigneeAgentId: worker.id, title: '子任务' });
    makeParentWaitingOnChild(parent.id, child.id);

    failTask(db, child.id, '执行异常');
    expect(areDependenciesMet(db, parent.id)).toBe(false);

    cancelTask(db, child.id);
    expect(getTask(db, child.id).state).toBe('cancelled');
    expect(areDependenciesMet(db, parent.id)).toBe(true);
    // cancelTask 内部 resumeDependents 已唤醒父任务
    expect(getTask(db, parent.id).state).toBe('queued');
  });

  it('多个子任务中取消失败者后，其余依赖未完成时父任务继续等待', () => {
    const { worker, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '父任务' });
    const child1 = createTask(db, { projectId: project.id, parentTaskId: parent.id, assigneeAgentId: worker.id, title: '子1' });
    const child2 = createTask(db, { projectId: project.id, parentTaskId: parent.id, assigneeAgentId: worker.id, title: '子2' });
    makeParentWaitingOnChild(parent.id, child1.id);
    makeParentWaitingOnChild(parent.id, child2.id);

    failTask(db, child1.id, '失败1');
    cancelTask(db, child1.id);
    // child2 还没完成 → 依赖未满足，父任务继续等待
    expect(areDependenciesMet(db, parent.id)).toBe(false);
    expect(getTask(db, parent.id).state).toBe('waiting_dependency');

    // 模拟 child2 执行中（completeTask 要求 running/claimed）
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), child2.id);
    completeTask(db, child2.id, { outcome: 'completed', summary: '完成', outboundTasks: [], artifacts: [] });
    expect(areDependenciesMet(db, parent.id)).toBe(true);
    expect(getTask(db, parent.id).state).toBe('queued');
  });

  it('resumeDependents 直接恢复依赖满足的 waiting_dependency 任务', () => {
    const { worker, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '父任务' });
    const child = createTask(db, { projectId: project.id, parentTaskId: parent.id, assigneeAgentId: worker.id, title: '子任务' });
    makeParentWaitingOnChild(parent.id, child.id);
    cancelTask(db, child.id);
    // cancelTask 已自动 resumeDependents 把父任务恢复为 queued；把父任务设回 waiting_dependency 后显式调用应再次恢复
    const now = new Date().toISOString();
    db.prepare("UPDATE task SET state='waiting_dependency', updated_at=? WHERE id=?").run(now, parent.id);
    const resumed = resumeDependents(db, child.id);
    expect(resumed).toContain(parent.id);
    expect(getTask(db, parent.id).state).toBe('queued');
  });
});

describe('cancel_child_task 工具', () => {
  function makeContext(askerTaskId: string, askerProjectId: string, askerProjectTaskId: string, askerAgentId: string): ToolContext {
    return {
      workingDir: '/tmp/worktree',
      readonlyDirs: [],
      toolRegistry: createBuiltinToolRegistry(),
      consultationContext: { db, askerTaskId, askerProjectId, askerProjectTaskId, askerAgentId },
    };
  }

  it('第一负责人可取消失败子任务，父任务恢复排队', async () => {
    const { lead, worker, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '父任务' });
    const child = createTask(db, { projectId: project.id, parentTaskId: parent.id, assigneeAgentId: worker.id, title: '子任务' });
    makeParentWaitingOnChild(parent.id, child.id);
    failTask(db, child.id, '执行异常');
    // lead 处理 [兜底] Task 时调用工具
    const bailoutTask = db
      .prepare(`SELECT id FROM task WHERE assignee_agent_id=? AND title LIKE '[兜底]%'`)
      .get(lead.id) as { id: string };
    const call: ToolCall = {
      id: 'tc_cancel',
      name: 'cancel_child_task',
      args: { child_task_id: child.id, reason: '资料找不到，放弃' },
    };
    const ctx = makeContext(bailoutTask.id, project.id, parent.projectTaskId, lead.id);
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('已取消子任务');
    expect(getTask(db, child.id).state).toBe('cancelled');
    expect(getTask(db, parent.id).state).toBe('queued');
    // 父任务收到取消通知
    const msgs = listTaskMessages(db, parent.id);
    expect(msgs.some((m) => m.content.includes('子任务取消') && m.content.includes('资料找不到'))).toBe(true);
  });

  it('普通员工（非第一负责人、非派发者）不能取消他人子任务', async () => {
    const { lead, worker, project } = fixture();
    const other = createAgent(db, { companyId: project.companyId, name: 'other', role: 'worker' });
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '父任务' });
    const child = createTask(db, { projectId: project.id, parentTaskId: parent.id, assigneeAgentId: worker.id, title: '子任务' });
    const otherTask = createTask(db, { projectId: project.id, assigneeAgentId: other.id, title: '无关任务' });
    const call: ToolCall = { id: 'tc', name: 'cancel_child_task', args: { child_task_id: child.id } };
    const ctx = makeContext(otherTask.id, project.id, otherTask.projectTaskId, other.id);
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('只有第一负责人或子任务派发者');
    expect(getTask(db, child.id).state).toBe('queued');
    void lead;
  });

  it('派发者本人可取消自己派发的子任务', async () => {
    const { worker, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '父任务' });
    const child = createTask(db, {
      projectId: project.id,
      parentTaskId: parent.id,
      dispatcherAgentId: worker.id,
      assigneeAgentId: worker.id,
      title: '子任务',
    });
    makeParentWaitingOnChild(parent.id, child.id);
    const parentClaim = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '模拟执行中' });
    const call: ToolCall = { id: 'tc', name: 'cancel_child_task', args: { child_task_id: child.id } };
    const ctx = makeContext(parentClaim.id, project.id, parentClaim.projectTaskId, worker.id);
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('已取消子任务');
    expect(getTask(db, parent.id).state).toBe('queued');
  });

  it('缺 consultationContext 时优雅降级', async () => {
    const call: ToolCall = { id: 'tc', name: 'cancel_child_task', args: { child_task_id: 'tk_x' } };
    const ctx: ToolContext = { workingDir: '/tmp', readonlyDirs: [], toolRegistry: createBuiltinToolRegistry() };
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('取消子任务通道未配置');
  });
});
