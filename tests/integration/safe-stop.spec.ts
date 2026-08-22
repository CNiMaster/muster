/**
 * 批次 H8：安全停（暂停/急停）引擎集成测试。
 * - 边界停：命令跑完（fake delay）→ 边界 throw → paused + 打断记录 + 回执 + worktree 保留，不判失败
 * - 急停（immediate）：不等边界直接 abort → 同样 paused 落记录（mode forced）
 * - 停止引发的错误不做执行器健康记账（不算执行器故障）
 * - 域层：requestStopTask 幂等/清位、requeueStoppedTask 回退迁移
 * - 继续：paused 后重排队再跑复用同一 worktree（半成品可见）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { makeTestDb, makeTempGitRepo } from './setup';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { restoreWorkbench, clockIn } from '../../src/server/domain/workbench';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import {
  createTask,
  getTask,
  requestStopTask,
  requeueStoppedTask,
} from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { getTaskRuntime } from '../../src/server/domain/task-runtime';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import type { AgentRunResult } from '../../src/shared/types';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

function fixture() {
  const c = restoreWorkbench(db, { id: 'wb_h8stop', name: 'co' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
  const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
  clockIn(db); // 引擎要求公司 online 才领取（须在员工创建后——上班期间锁员工配置）
  return { c, lead, writer, project };
}

const DONE: AgentRunResult = { outcome: 'completed', summary: '完成了', outboundTasks: [], artifacts: [] };

/** 造一个对话型任务 + 线程（回执消息需要 scope=project）。 */
function makeConversationTask(projectId: string, writerId: string, content: string) {
  const task = createTask(db, {
    projectId,
    assigneeAgentId: writerId,
    title: content.slice(0, 10),
    inputProtocol: { trigger: 'user_message', scope: 'project', scopeId: projectId, content },
  });
  const thread = ensurePrimaryThread(db, projectId, writerId);
  return { task, thread };
}

/** 等引擎把 run 拉起来（activeStops 就绪的信号=requestStop 返回 true），置位后返回。 */
async function stopWhenRunning(engine: TaskEngine, taskId: string, opts?: { immediate?: boolean }): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (engine.requestStop(taskId, opts)) {
      requestStopTask(db, taskId);
      return true;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe('H8 安全停：引擎集成', () => {
  it('边界停——命令跑完到边界停下：paused+打断记录+回执，已写文件保留在 worktree，不判失败', async () => {
    const { project, writer } = fixture();
    const { task, thread } = makeConversationTask(project.id, writer.id, '把草稿写出来');
    const fake = new FakeExecutor();
    // 步1先写文件（已完成动作）；步骤2 delay=模拟"命令正在跑"（150ms）——停止不打断它，跑完后到边界（步末 throw，未开始的动作不再执行）
    fake.script([{ writeFiles: { 'draft.txt': '写到一半' }, delayMs: 150 }]);
    const engine = new TaskEngine(db, fake);
    const p = engine.pumpThread(thread.id);

    expect(await stopWhenRunning(engine, task.id)).toBe(true);
    await p;

    const t = getTask(db, task.id);
    expect(t.state).toBe('paused'); // 不是 failed，也不是 queued（打断≠重跑）
    expect(t.stopRequested).toBe(false); // 收尾清位

    const events = listTaskEvents(db, task.id);
    expect(events.some((e) => e.kind === 'stop_requested')).toBe(true);
    const interrupted = events.find((e) => e.kind === 'interrupted');
    expect(interrupted).toBeDefined();
    expect((interrupted!.payload as { mode?: string }).mode).toBe('boundary');
    expect((interrupted!.payload as { fileCount?: number }).fileCount).toBe(1);

    // 生效回执（对话区系统消息；受理回执由 API 层发——HTTP 级测试覆盖）
    const msgs = db.prepare("SELECT content FROM conversation_message WHERE scope_kind='project' ORDER BY created_at").all() as Array<{ content: string }>;
    expect(msgs.some((m) => m.content.includes('已暂停'))).toBe(true);

    // worktree 保留（task_runtime 未删）且半成品在
    const runtime = getTaskRuntime(db, task.id);
    expect(runtime).not.toBeNull();
    expect(existsSync(`${runtime!.path}/draft.txt`)).toBe(true);
  });

  it('急停（immediate）——不等边界：同样 paused 落打断记录（mode forced）', async () => {
    const { project, writer } = fixture();
    const { task, thread } = makeConversationTask(project.id, writer.id, '长时间命令');
    const fake = new FakeExecutor();
    fake.script([{ writeFiles: { 'x.txt': 'x' }, delayMs: 10_000 }]); // 长命令，急停不等它
    const engine = new TaskEngine(db, fake);
    const p = engine.pumpThread(thread.id);

    expect(await stopWhenRunning(engine, task.id, { immediate: true })).toBe(true);
    await p; // abort 让 fake 的 delay 立即 reject → 引擎 catch → 安全停收尾（mode=forced：主信号被 abort）

    const t = getTask(db, task.id);
    expect(t.state).toBe('paused');
    expect(t.state).not.toBe('failed');
    const events = listTaskEvents(db, task.id);
    expect(events.some((e) => e.kind === 'stop_forced')).toBe(true);
    const interrupted = events.find((e) => e.kind === 'interrupted');
    expect((interrupted!.payload as { mode?: string }).mode).toBe('forced');
  });

  it('停止不记执行器健康故障（用户操作≠执行器故障）', async () => {
    const { project, writer } = fixture();
    const { task, thread } = makeConversationTask(project.id, writer.id, '检查健康记账');
    const fake = new FakeExecutor();
    fake.script([{ delayMs: 10_000 }]);
    const engine = new TaskEngine(db, fake);
    const p = engine.pumpThread(thread.id);
    expect(await stopWhenRunning(engine, task.id, { immediate: true })).toBe(true);
    await p;
    // executor 无 unhealthy 事件（健康记账在内层 catch 之前已被安全停分支短路）
    const evts = listTaskEvents(db, task.id);
    expect(evts.some((e) => e.kind === 'executor_unhealthy')).toBe(false);
  });

  it('继续——paused 后重新排队再跑：复用同一 worktree，半成品可见', async () => {
    const { project, writer } = fixture();
    const { task, thread } = makeConversationTask(project.id, writer.id, '续跑验证');
    const fake = new FakeExecutor();
    fake.script([{ writeFiles: { 'part.txt': '半成品' }, delayMs: 120 }]);
    const engine = new TaskEngine(db, fake);
    const p1 = engine.pumpThread(thread.id);
    expect(await stopWhenRunning(engine, task.id)).toBe(true);
    await p1;
    expect(getTask(db, task.id).state).toBe('paused');
    const firstWorkdir = fake.calls[0]!.workingDir;

    // resumeTask→claimed 后走租约恢复语义重排队（测试直改 queued 模拟 recoverExpiredLeases）
    requeueStoppedTask(db, task.id);
    expect(getTask(db, task.id).state).toBe('queued');
    fake.script([{ expectFiles: { 'part.txt': '半成品' }, result: DONE }]);
    const p2 = engine.pumpThread(thread.id);
    await p2;

    expect(getTask(db, task.id).state).toBe('completed');
    expect(fake.calls[1]!.workingDir).toBe(firstWorkdir); // 同一 worktree 续跑
  });
});

describe('H8 域层', () => {
  it('requestStopTask：置位+事件+幂等；不存在抛 NOT_FOUND', () => {
    const { project, writer } = fixture();
    const { task } = makeConversationTask(project.id, writer.id, '域层');
    const t1 = requestStopTask(db, task.id);
    expect(t1.stopRequested).toBe(true);
    requestStopTask(db, task.id); // 幂等：不抛错
    expect(getTask(db, task.id).stopRequested).toBe(true);
    expect(listTaskEvents(db, task.id).some((e) => e.kind === 'stop_requested')).toBe(true);
    expect(() => requestStopTask(db, 'tk_不存在')).toThrow();
  });

  it('requeueStoppedTask（回退）：paused→queued 合法迁移 + 清停止位 + 落事件', () => {
    const { project, writer } = fixture();
    const { task } = makeConversationTask(project.id, writer.id, '回退');
    db.prepare("UPDATE task SET state='paused' WHERE id=?").run(task.id);
    const requeued = requeueStoppedTask(db, task.id);
    expect(requeued.state).toBe('queued');
    expect(requeued.stopRequested).toBe(false);
    expect(listTaskEvents(db, task.id).some((e) => e.kind === 'stop_discarded')).toBe(true);
    // 非 paused 态回退被状态机拦住
    db.prepare("UPDATE task SET state='completed' WHERE id=?").run(task.id);
    expect(() => requeueStoppedTask(db, task.id)).toThrow();
  });
});
