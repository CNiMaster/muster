/**
 * 批次 F.4：waiting_input 超时自动继续（域级集成）。
 *
 * 语义矩阵：默认一直等（全局 0）/ 全局开到期续跑+system 留痕 / 任务级覆盖优先（0=本任务一直等）/
 * 用户停止跳过 / 辩论进行中跳过 / 已答竞态由 state 过滤兜底 / setTaskAutoContinue 快调。
 * 等待起点回退 updated_at（无挂起行），故用手工回拨 updated_at 构造到期。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb, makeTempGitRepo, createNovelCompany } from './setup';
import type { DB } from '../../src/server/db/client';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, autoContinueDueWaitingTasks, setTaskAutoContinue } from '../../src/server/domain/task';
import { getSetting, setSetting } from '../../src/server/domain/setting';
import { listTaskMessages } from '../../src/server/domain/task-message';

let db: DB;
let projectId: string;

beforeEach(() => {
  db = makeTestDb().db;
  const novel = createNovelCompany(db, { name: 'co' });
  projectId = createProject(db, {
    companyId: novel.company.id,
    name: 'proj',
    rootDir: makeTempGitRepo(),
    initialState: 'active',
  }).id;
});

function seedWaitingTask(minutesAgo: number, overrides: { autoContinueMinutes?: number | null; stopped?: boolean } = {}): string {
  const task = createTask(db, { projectId, title: '等待中的任务' });
  const past = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  db.prepare(
    `UPDATE task SET state='waiting_input', question='要不要继续？', updated_at=?,
       auto_continue_minutes=?, auto_continue_stopped=? WHERE id=?`,
  ).run(past, overrides.autoContinueMinutes ?? null, overrides.stopped ? 1 : 0, task.id);
  return task.id;
}

describe('autoContinueDueWaitingTasks（批次 F.4）', () => {
  it('默认一直等：全局未开启时到期也不自动继续', () => {
    const taskId = seedWaitingTask(60);
    expect(getSetting(db, 'waiting_auto_continue_minutes', '0')).toBe('0');
    expect(autoContinueDueWaitingTasks(db)).toBe(0);
    expect(getTask(db, taskId).state).toBe('waiting_input');
  });

  it('全局开启后到期自动继续：state→queued + system 留痕 + 答复消息', () => {
    setSetting(db, 'waiting_auto_continue_minutes', '10');
    const taskId = seedWaitingTask(11);
    expect(autoContinueDueWaitingTasks(db)).toBe(1);
    const task = getTask(db, taskId);
    expect(task.state).toBe('queued');
    const messages = listTaskMessages(db, taskId);
    expect(messages.some((m) => m.content.includes('确认，请继续执行'))).toBe(true);
    expect(messages.some((m) => m.author === 'system' && m.content.includes('已自动继续执行'))).toBe(true);
  });

  it('未到期不动', () => {
    setSetting(db, 'waiting_auto_continue_minutes', '10');
    seedWaitingTask(3);
    expect(autoContinueDueWaitingTasks(db)).toBe(0);
  });

  it('任务级覆盖优先：全局关但任务开 5 分钟 → 到期续跑', () => {
    const taskId = seedWaitingTask(6, { autoContinueMinutes: 5 });
    expect(autoContinueDueWaitingTasks(db)).toBe(1);
    expect(getTask(db, taskId).state).toBe('queued');
  });

  it('任务级 0=本任务一直等：全局开也不动', () => {
    setSetting(db, 'waiting_auto_continue_minutes', '10');
    seedWaitingTask(30, { autoContinueMinutes: 0 });
    expect(autoContinueDueWaitingTasks(db)).toBe(0);
  });

  it('用户停止后跳过（任何交互永久停计）', () => {
    setSetting(db, 'waiting_auto_continue_minutes', '10');
    seedWaitingTask(30, { stopped: true });
    expect(autoContinueDueWaitingTasks(db)).toBe(0);
  });

  it('评审庭辩论进行中跳过，等辩论流程自行收口', () => {
    setSetting(db, 'waiting_auto_continue_minutes', '10');
    const taskId = seedWaitingTask(30);
    db.prepare(
      `INSERT INTO debate (id, project_id, question, status, origin_task_id, created_at)
       VALUES ('deb_1', ?, '辩一辩', 'open', ?, ?)`,
    ).run(projectId, taskId, new Date().toISOString());
    expect(autoContinueDueWaitingTasks(db)).toBe(0);
    expect(getTask(db, taskId).state).toBe('waiting_input');
  });

  it('setTaskAutoContinue 快调：minutes 置/清 + stop 置/清', () => {
    const taskId = seedWaitingTask(0);
    expect(setTaskAutoContinue(db, taskId, { minutes: 10 }).autoContinueMinutes).toBe(10);
    expect(setTaskAutoContinue(db, taskId, { stop: true }).autoContinueStopped).toBe(true);
    // stop:false 恢复 + minutes:null 回跟随全局
    const restored = setTaskAutoContinue(db, taskId, { stop: false, minutes: null });
    expect(restored.autoContinueStopped).toBe(false);
    expect(restored.autoContinueMinutes).toBeNull();
  });
});
