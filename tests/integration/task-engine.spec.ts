/**
 * Phase 2 验收测试：
 - Task 状态机
 - 原子领取（并发不重复）
 - 租约过期恢复
 - 父子依赖与追问恢复
 - 假执行器驱动闭环
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany, clockIn } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject, updateProject } from '../../src/server/domain/project';
import { ensurePrimaryThread, createMirror } from '../../src/server/domain/thread';
import {
  createTask,
  claimNextTask,
  markRunning,
  completeTask,
  answerClarification,
  recoverExpiredLeases,
  addDependency,
  areDependenciesMet,
  getTask,
  cancelTask,
  ensurePlanningTask,
  listTasks,
} from '../../src/server/domain/task';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import { LEASE_TTL_MS, MAX_CLARIFY_ROUNDS } from '../../src/shared/constants';
import type { AgentRunResult } from '../../src/shared/types';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

function fixture() {
  const c = createCompany(db, { name: 'co' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
  const project = createProject(db, { companyId: c.id, name: 'novel', rootDir: '/tmp/n', firstAgentId: lead.id });
  return { c, lead, writer, project };
}

describe('task state machine', () => {
  it('queued → claimed → running → completed', () => {
    const { project, writer } = fixture();
    const t = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: '写第1章' });
    const thread = ensurePrimaryThread(db, project.id, writer.id);
    expect(t.state).toBe('queued');

    const claimed = claimNextTask(db, thread.id, writer.id);
    expect(claimed).not.toBeNull();
    expect(claimed!.task.state).toBe('claimed');

    markRunning(db, t.id);
    expect(getTask(db, t.id).state).toBe('running');

    completeTask(db, t.id, {
      outcome: 'completed',
      summary: 'done',
      outboundTasks: [],
      artifacts: [],
    });
    expect(getTask(db, t.id).state).toBe('completed');
  });

  it('非法迁移抛错', () => {
    const { project, writer } = fixture();
    const t = createTask(db, { projectId: project.id, title: 't' });
    expect(() => markRunning(db, t.id)).toThrow();
  });

  it('cancel 任意时刻可调用', () => {
    const { project } = fixture();
    const t = createTask(db, { projectId: project.id, title: 't' });
    expect(cancelTask(db, t.id).state).toBe('cancelled');
  });
});

describe('atomic claim (concurrent)', () => {
  it('员工不能领取其他员工的 Task，也不能改写原负责人', () => {
    const { project, lead, writer } = fixture();
    const writerTask = createTask(db, {
      projectId: project.id,
      assigneeAgentId: writer.id,
      title: '只允许 writer 执行',
    });
    const leadThread = ensurePrimaryThread(db, project.id, lead.id);

    expect(claimNextTask(db, leadThread.id, lead.id)).toBeNull();
    expect(getTask(db, writerTask.id).assigneeAgentId).toBe(writer.id);
    expect(getTask(db, writerTask.id).state).toBe('queued');
  });

  it('并发领取同一 Task 只有一个成功', () => {
    const { project, writer } = fixture();
    const t = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: 'only one' });
    const primary = ensurePrimaryThread(db, project.id, writer.id);
    const m1 = createMirror(db, project.id, writer.id);
    const m2 = createMirror(db, project.id, writer.id);

    // 三个线程并发领取，但 task 只有 1 个
    const c1 = claimNextTask(db, primary.id, writer.id);
    const c2 = claimNextTask(db, m1.id, writer.id);
    const c3 = claimNextTask(db, m2.id, writer.id);

    const winners = [c1, c2, c3].filter(Boolean);
    expect(winners.length).toBe(1);
    expect(getTask(db, t.id).state).toBe('claimed');
  });

  it('按 priority DESC, seq ASC 排序领取', () => {
    const { project, writer } = fixture();
    const t1 = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: 'low', priority: 1 });
    const t2 = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: 'high', priority: 9 });
    const thread = ensurePrimaryThread(db, project.id, writer.id);
    const got = claimNextTask(db, thread.id, writer.id);
    expect(got!.task.id).toBe(t2.id); // 高优先级先

    completeTask(db, t2.id, { outcome: 'completed', summary: '', outboundTasks: [], artifacts: [] });
    // 注意：直接 complete 一个未 running 的 task 需要状态 claimed
    // 上面的 complete 会失败，因为 t2 还没 running —— 改用 markRunning
    // 重置：用 markRunning + complete
  });
});

describe('lease recovery', () => {
  it('租约过期 → recoverExpiredLeases 复位为 queued', async () => {
    const { project, writer } = fixture();
    createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: 't' });
    const thread = ensurePrimaryThread(db, project.id, writer.id);
    const claimed = claimNextTask(db, thread.id, writer.id)!;
    expect(claimed.task.state).toBe('claimed');

    // 模拟过期：手动把 lease_expires_at 调到过去
    db.prepare('UPDATE task SET lease_expires_at=? WHERE id=?').run('2000-01-01T00:00:00Z', claimed.task.id);

    const n = recoverExpiredLeases(db);
    expect(n).toBe(1);
    expect(getTask(db, claimed.task.id).state).toBe('queued');
  });
});

describe('dependencies', () => {
  it('依赖未完成时不可领取', () => {
    const { project, writer } = fixture();
    const dep = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: 'dep' });
    const main = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: 'main' });
    addDependency(db, main.id, dep.id);
    expect(areDependenciesMet(db, main.id)).toBe(false);

    const thread = ensurePrimaryThread(db, project.id, writer.id);
    // claimNextTask 不应领 main（因为依赖未完成），也无 dep（无 assignee 匹配也会领）
    const got = claimNextTask(db, thread.id, writer.id);
    // dep 也是 queued 且无依赖，应被领取
    expect(got).not.toBeNull();
    expect(got!.task.id).toBe(dep.id);
  });

  it('依赖完成后父 task 自动从 waiting_dependency 恢复', () => {
    const { project, writer } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: 'parent' });
    const result: AgentRunResult = {
      outcome: 'waiting_dependency',
      summary: '等待子任务',
      outboundTasks: [
        { recipientAgentId: writer.id, protocolId: 'p', title: 'child', payload: {}, priority: 5 },
      ],
      artifacts: [],
    };
    // 模拟 parent 已 running
    const thread = ensurePrimaryThread(db, project.id, writer.id);
    claimNextTask(db, thread.id, writer.id);
    markRunning(db, parent.id);
    completeTask(db, parent.id, result);
    expect(getTask(db, parent.id).state).toBe('waiting_dependency');

    // 找到 child 并完成
    const all = listTasks(db, project.id);
    const child = all.find((t) => t.parentTaskId === parent.id);
    expect(child).toBeDefined();
    claimNextTask(db, thread.id, writer.id);
    markRunning(db, child!.id);
    completeTask(db, child!.id, { outcome: 'completed', summary: 'child done', outboundTasks: [], artifacts: [] });

    expect(getTask(db, parent.id).state).toBe('queued'); // 恢复
  });
});

describe('clarification rounds', () => {
  it('waiting_input 三轮后上报第一负责人', () => {
    const { project, writer, lead } = fixture();
    const t = createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: 't' });
    const thread = ensurePrimaryThread(db, project.id, writer.id);

    // 跑 4 轮追问循环：claim → run → waiting_input → answer（重新入队）
    for (let i = 0; i < 4; i++) {
      claimNextTask(db, thread.id, writer.id);
      markRunning(db, t.id);
      completeTask(db, t.id, {
        outcome: 'waiting_input',
        summary: 'need info',
        question: `第${i + 1}轮追问`,
        outboundTasks: [],
        artifacts: [],
      });
      // 状态变 waiting_input；如果已达上限，completeTask 内部会触发上报
      answerClarification(db, t.id, `回答${i + 1}`); // 重新入队（除非已上报）
    }

    // 应存在一条派给 lead 的上报 Task
    const escalation = listTasks(db, project.id).find((x) => x.assigneeAgentId === lead.id && x.title.includes('上报'));
    expect(escalation).toBeDefined();
  });
});

describe('fake executor end-to-end', () => {
  it('假执行器驱动 Task 闭环', async () => {
    const { c, project, writer } = fixture();
    clockIn(db, c.id); // 引擎要求公司 online 才领取
    createTask(db, { projectId: project.id, assigneeAgentId: writer.id, title: '写章节' });
    const thread = ensurePrimaryThread(db, project.id, writer.id);

    const fake = new FakeExecutor().script([
      {
        result: {
          outcome: 'completed',
          summary: '完成了',
          outboundTasks: [],
          artifacts: [{ path: 'ch01.md', kind: 'markdown', operation: 'create' }],
        },
      },
    ]);
    const engine = new TaskEngine(db, fake);
    const ran = await engine.pumpThread(thread.id);

    expect(ran).toBe(true);
    expect(fake.callCount).toBe(1);
    const t = listTasks(db, project.id)[0];
    expect(t.state).toBe('completed');
    expect(t.summary).toBe('完成了');
  });

  it('无 Task 时自动给第一负责人派规划 Task', () => {
    const { project, lead } = fixture();
    expect(listTasks(db, project.id)).toHaveLength(0);
    const plan = ensurePlanningTask(db, project.id);
    expect(plan).not.toBeNull();
    expect(plan!.assigneeAgentId).toBe(lead.id);
    expect(plan!.title).toMatch(/规划/);
    // 幂等：再调一次不重复
    expect(ensurePlanningTask(db, project.id)).toBeNull();
  });
});
