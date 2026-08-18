/**
 * spawn_tasks 并行派发（阶段七任务 7.1）集成测试。
 *
 * 验证：
 * 1. spawn_tasks 工具一次派发多个子任务 + join=all 建依赖
 * 2. join=any：任一子任务完成即恢复父任务，其余自动取消，写汇总消息
 * 3. join=quorum：多数完成即恢复
 * 4. join=best-effort：不等待（不建依赖）
 * 5. 跨公司派发被拒绝
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, completeTask, areDependenciesMet } from '../../src/server/domain/task';
import { executeTool, createBuiltinToolRegistry, type ToolCall, type ToolContext } from '../../src/server/executors/tools/registry';
import { listTaskMessages } from '../../src/server/domain/task-message';
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
  const explorer = createAgent(db, { companyId: c.id, name: 'explorer', role: 'explorer' });
  const librarian = createAgent(db, { companyId: c.id, name: 'librarian', role: 'librarian' });
  const designer = createAgent(db, { companyId: c.id, name: 'designer', role: 'designer' });
  // lead 授权联系所有同事（spawn_tasks 派发需要 contactAllow）
  db.prepare('UPDATE agent_definition SET contact_allow_json=? WHERE id=?')
    .run(JSON.stringify([explorer.id, librarian.id, designer.id]), lead.id);
  const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
  return { c, lead, explorer, librarian, designer, project };
}

function makeContext(askerTaskId: string, askerProjectId: string, askerProjectTaskId: string, askerAgentId: string): ToolContext {
  return {
    workingDir: '/tmp/worktree',
    readonlyDirs: [],
    toolRegistry: createBuiltinToolRegistry(),
    consultationContext: { db, askerTaskId, askerProjectId, askerProjectTaskId, askerAgentId },
  };
}

/** 模拟父任务以 waiting_dependency 结束。 */
function markWaitingDep(taskId: string): void {
  db.prepare("UPDATE task SET state='waiting_dependency', outcome='waiting_dependency', updated_at=? WHERE id=?")
    .run(new Date().toISOString(), taskId);
}

/** 模拟子任务执行完成。 */
function completeChild(childId: string, summary: string): void {
  db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), childId);
  completeTask(db, childId, { outcome: 'completed', summary, outboundTasks: [], artifacts: [] });
}

describe('spawn_tasks 工具（阶段七任务 7.1）', () => {
  it('join=all：一次派发 3 个子任务并建依赖，全部完成后父任务恢复', async () => {
    const { lead, explorer, librarian, designer, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '调研任务' });
    const call: ToolCall = {
      id: 'tc_spawn',
      name: 'spawn_tasks',
      args: {
        join_policy: 'all',
        tasks: [
          { title: '搜索代码库', assignee_agent_id: explorer.id },
          { title: '查文档', assignee_agent_id: librarian.id },
          { title: '设计方案', assignee_agent_id: designer.id },
        ],
      },
    };
    const result = await executeTool(call, makeContext(parent.id, project.id, parent.projectTaskId, lead.id));
    expect(result.content).toContain('已并行派发 3 个子任务');
    expect(result.content).toContain('waiting_dependency');
    // 3 个子任务 + 依赖
    const children = db.prepare('SELECT id FROM task WHERE parent_task_id=?').all(parent.id) as Array<{ id: string }>;
    expect(children.length).toBe(3);
    for (const child of children) {
      expect(areDependenciesMet(db, parent.id)).toBe(false);
      void child;
    }
    // 父任务 join 策略已记录
    const proto = (getTask(db, parent.id).inputProtocol as Record<string, unknown>);
    expect(proto.spawnJoinPolicy).toBe('all');
    expect(proto.spawnCount).toBe(3);
    // 全部完成后恢复
    markWaitingDep(parent.id);
    for (const child of children) completeChild(child.id, '完成');
    expect(getTask(db, parent.id).state).toBe('queued');
  });

  it('join=any：任一完成即恢复父任务，其余自动取消，写汇总消息', async () => {
    const { lead, explorer, librarian, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '调研任务' });
    const call: ToolCall = {
      id: 'tc_spawn',
      name: 'spawn_tasks',
      args: {
        join_policy: 'any',
        tasks: [
          { title: '搜索代码库', assignee_agent_id: explorer.id },
          { title: '查文档', assignee_agent_id: librarian.id },
        ],
      },
    };
    await executeTool(call, makeContext(parent.id, project.id, parent.projectTaskId, lead.id));
    const children = db.prepare('SELECT id FROM task WHERE parent_task_id=? ORDER BY seq').all(parent.id) as Array<{ id: string }>;
    expect(children.length).toBe(2);
    markWaitingDep(parent.id);
    // explorer 先完成 → 父任务恢复 + librarian 取消 + 汇总
    completeChild(children[0]!.id, '找到关键代码');
    expect(getTask(db, parent.id).state).toBe('queued');
    expect(getTask(db, children[1]!.id).state).toBe('cancelled');
    const msgs = listTaskMessages(db, parent.id);
    const summary = msgs.find((m) => m.content.includes('子任务汇总'));
    expect(summary).toBeDefined();
    expect(summary!.content).toContain('找到关键代码');
    expect(summary!.content).toContain('1/2');
  });

  it('join=quorum：多数（2/3）完成即恢复，其余取消', async () => {
    const { lead, explorer, librarian, designer, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '调研任务' });
    const call: ToolCall = {
      id: 'tc_spawn',
      name: 'spawn_tasks',
      args: {
        join_policy: 'quorum',
        tasks: [
          { title: 'A', assignee_agent_id: explorer.id },
          { title: 'B', assignee_agent_id: librarian.id },
          { title: 'C', assignee_agent_id: designer.id },
        ],
      },
    };
    await executeTool(call, makeContext(parent.id, project.id, parent.projectTaskId, lead.id));
    const children = db.prepare('SELECT id FROM task WHERE parent_task_id=? ORDER BY seq').all(parent.id) as Array<{ id: string }>;
    markWaitingDep(parent.id);
    // 1 个完成 → 未达多数，父任务保持等待
    completeChild(children[0]!.id, 'A 完成');
    expect(getTask(db, parent.id).state).toBe('waiting_dependency');
    // 2 个完成 → 达多数（ceil(3/2)=2）→ 恢复 + 取消第 3 个
    completeChild(children[1]!.id, 'B 完成');
    expect(getTask(db, parent.id).state).toBe('queued');
    expect(getTask(db, children[2]!.id).state).toBe('cancelled');
  });

  it('join=quorum：偶数子任务时多数 = 半数+1（2 个子任务需 2 个都完成）', async () => {
    const { lead, explorer, librarian, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '调研任务' });
    const call: ToolCall = {
      id: 'tc_spawn',
      name: 'spawn_tasks',
      args: {
        join_policy: 'quorum',
        tasks: [
          { title: 'A', assignee_agent_id: explorer.id },
          { title: 'B', assignee_agent_id: librarian.id },
        ],
      },
    };
    await executeTool(call, makeContext(parent.id, project.id, parent.projectTaskId, lead.id));
    const children = db.prepare('SELECT id FROM task WHERE parent_task_id=? ORDER BY seq').all(parent.id) as Array<{ id: string }>;
    markWaitingDep(parent.id);
    // 1 个完成 → 未达多数（2 个的多数 = 2），父任务保持等待
    completeChild(children[0]!.id, 'A 完成');
    expect(getTask(db, parent.id).state).toBe('waiting_dependency');
    // 2 个完成 → 达多数 → 恢复
    completeChild(children[1]!.id, 'B 完成');
    expect(getTask(db, parent.id).state).toBe('queued');
  });

  it('join=best-effort：不建依赖，父任务不等待', async () => {
    const { lead, explorer, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '主任务' });
    const call: ToolCall = {
      id: 'tc_spawn',
      name: 'spawn_tasks',
      args: {
        join_policy: 'best-effort',
        tasks: [{ title: '异步子任务', assignee_agent_id: explorer.id }],
      },
    };
    const result = await executeTool(call, makeContext(parent.id, project.id, parent.projectTaskId, lead.id));
    expect(result.content).toContain('best-effort');
    expect(result.content).not.toContain('waiting_dependency');
    // 无依赖
    const deps = db.prepare('SELECT COUNT(*) n FROM task_dependency WHERE task_id=?').get(parent.id) as { n: number };
    expect(deps.n).toBe(0);
  });

  it('未授权联系人派发被拒绝（公司退役批次D：跨公司归属已坍缩，通信白名单守卫仍生效）', async () => {
    const { lead, project } = fixture();
    const other = createCompany(db, { name: 'other' });
    const stranger = createAgent(db, { companyId: other.id, name: 'stranger', role: 'x' });
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '主任务' });
    const call: ToolCall = {
      id: 'tc_spawn',
      name: 'spawn_tasks',
      args: { tasks: [{ title: '越权任务', assignee_agent_id: stranger.id }] },
    };
    const result = await executeTool(call, makeContext(parent.id, project.id, parent.projectTaskId, lead.id));
    // 单例工作台语义下不再按公司拒绝，但 lead 未授权联系 stranger → 仍被通信白名单拦截
    expect(result.content).toContain('未授权联系');
    const children = db.prepare('SELECT COUNT(*) n FROM task WHERE parent_task_id=?').get(parent.id) as { n: number };
    expect(children.n).toBe(0);
  });
});
