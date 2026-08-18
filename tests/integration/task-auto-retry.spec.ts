import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 任务级自动重试（阶段一任务 1.4）集成测试。
 *
 * 验证：
 * 1. 可重试失败（超时/网络）→ 自动回 queued，auto_retry_count+1，事件 auto_retry_scheduled
 * 2. 第二次可重试失败 → retry_after_at 在未来（延迟 30 秒）
 * 3. 超过自动重试上限 → 保持 failed + 失败传播（父任务收到 [兜底] 上报）
 * 4. 不可重试失败（权限/安全）→ 保持 failed，不自动重试
 * 5. claimNextTask 过滤 retry_after_at：延迟未到不可领，延迟过后可领
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, failTask, claimNextTask } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
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

describe('任务级自动重试（阶段一任务 1.4）', () => {
  it('可重试失败自动回 queued 并累计重试次数', () => {
    const { worker, project } = fixture();
    const task = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '会失败的任务' });
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);

    const after = failTask(db, task.id, '执行异常：network timeout');

    expect(after.state).toBe('queued');
    expect(after.autoRetryCount).toBe(1);
    expect(after.retryAfterAt).toBeNull(); // 首次立即重试
    const event = db.prepare("SELECT * FROM task_event WHERE task_id=? AND kind='auto_retry_scheduled'").get(task.id);
    expect(event).toBeDefined();
  });

  it('第二次可重试失败延迟 30 秒（retry_after_at 在未来）', () => {
    const { worker, project } = fixture();
    const task = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '会失败的任务' });
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);

    const first = failTask(db, task.id, '执行异常：timeout');
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), first.id);
    const second = failTask(db, first.id, '执行异常：timeout');

    expect(second.state).toBe('queued');
    expect(second.autoRetryCount).toBe(2);
    expect(second.retryAfterAt).not.toBeNull();
    expect(new Date(second.retryAfterAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('超过自动重试上限保持 failed 并触发失败传播（父任务收到通知 + 兜底上报）', () => {
    const { lead, worker, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '父任务' });
    const child = createTask(db, { projectId: project.id, parentTaskId: parent.id, assigneeAgentId: worker.id, title: '子任务' });
    // 父任务 waiting_dependency 依赖 child
    db.prepare(`INSERT INTO task_dependency (task_id, depends_on_id) VALUES (?, ?)`).run(parent.id, child.id);
    db.prepare("UPDATE task SET state='waiting_dependency', updated_at=? WHERE id=?").run(new Date().toISOString(), parent.id);
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), child.id);

    // 3 次可重试失败：前 2 次自动重试，第 3 次保持 failed
    const first = failTask(db, child.id, '执行异常：timeout');
    expect(first.state).toBe('queued');
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), first.id);
    const second = failTask(db, first.id, '执行异常：timeout');
    expect(second.state).toBe('queued');
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), second.id);
    const third = failTask(db, second.id, '执行异常：timeout');

    expect(third.state).toBe('failed');
    expect(third.autoRetryCount).toBe(2);
    // 失败传播仍生效：父任务收到失败通知 + lead 收到 [兜底] 上报
    const msgs = listTaskMessages(db, parent.id);
    expect(msgs.some((m) => m.content.includes('子任务失败'))).toBe(true);
    const bailouts = db.prepare(`SELECT id FROM task WHERE assignee_agent_id=? AND title LIKE '[兜底]%'`).all(lead.id);
    expect(bailouts.length).toBe(1);
  });

  it('不可重试失败保持 failed，不自动重试', () => {
    const { worker, project } = fixture();
    const task = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '权限失败的任务' });
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);

    const after = failTask(db, task.id, '执行异常：permission denied: user has no access');

    expect(after.state).toBe('failed');
    expect(after.autoRetryCount).toBe(0);
    const event = db.prepare("SELECT 1 FROM task_event WHERE task_id=? AND kind='auto_retry_scheduled'").get(task.id);
    expect(event).toBeUndefined();
  });

  it('claimNextTask 在 retry_after_at 延迟期内不可领取，延迟过后可领取', () => {
    const { worker, project } = fixture();
    const task = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '延迟重试的任务' });
    // 模拟第二次重试后的延迟状态
    db.prepare(
      `UPDATE task SET state='queued', auto_retry_count=2, retry_after_at=?, updated_at=? WHERE id=?`,
    ).run(new Date(Date.now() + 30_000).toISOString(), new Date().toISOString(), task.id);

    const thread = ensurePrimaryThread(db, project.id, worker.id);
    // 延迟未到：领不到
    expect(claimNextTask(db, thread.id, worker.id)).toBeNull();
    // 延迟已过：可领取
    db.prepare("UPDATE task SET retry_after_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), task.id);
    const claimed = claimNextTask(db, thread.id, worker.id);
    expect(claimed?.task.id).toBe(task.id);
  });

  it('自动重试不影响父任务（父任务继续等待），不产生失败传播', () => {
    const { lead, worker, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '父任务' });
    const child = createTask(db, { projectId: project.id, parentTaskId: parent.id, assigneeAgentId: worker.id, title: '子任务' });
    // 父任务 waiting_dependency 依赖 child
    db.prepare(
      `INSERT INTO task_dependency (task_id, depends_on_id) VALUES (?, ?)`,
    ).run(parent.id, child.id);
    db.prepare("UPDATE task SET state='waiting_dependency', updated_at=? WHERE id=?").run(new Date().toISOString(), parent.id);
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), child.id);

    const after = failTask(db, child.id, '执行异常：network econn refused');

    // 自动重试成功，父任务保持 waiting_dependency 且无失败通知
    expect(after.state).toBe('queued');
    expect(getTask(db, parent.id).state).toBe('waiting_dependency');
    const msgs = listTaskMessages(db, parent.id);
    expect(msgs.some((m) => m.content.includes('子任务失败'))).toBe(false);
    const bailouts = db.prepare(`SELECT id FROM task WHERE assignee_agent_id=? AND title LIKE '[兜底]%'`).all(lead.id);
    expect(bailouts).toHaveLength(0);
  });
});
