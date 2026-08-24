import { clockIn, restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 指挥系统批次1：定时自动化补齐——每天 N 点时刻语义 / 防叠跑 / 公司级触发器 / 晨醒开关。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { listTasks, getTask } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import {
  dispatchDueScheduleTriggers,
  listCompanyTriggers,
  registerScheduleTrigger,
  setCompanyTriggerEnabled,
  deleteCompanyTrigger,
} from '../../src/server/domain/triggers';
import { AppError } from '../../src/shared/errors';
import { makeTestDb } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

function makeCompanyFixture() {
  const company = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' });
  const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
  const project = createProject(db, {
    companyId: company.id,
    name: 'p1',
    rootDir: '/tmp/schedule-automation',
    firstAgentId: lead.id,
    initialState: 'active',
  });
  clockIn(db);
  return { company, lead, project };
}

describe('daily（每天 N 点）触发器', () => {
  it('注册时 next_run_at 为时区内下一个该时刻；派发后推进到明天同时刻', () => {
    const { project } = makeCompanyFixture();
    registerScheduleTrigger(db, {
      projectId: project.id,
      timeOfDay: '09:00',
      timezone: 'Asia/Shanghai',
      template: { checkKind: 'omission' },
      now: new Date('2026-08-14T02:00:00.000Z'), // 上海 10:00，今天 09:00 已过
    });
    const triggers = db.prepare('SELECT * FROM trigger').all() as Array<{ next_run_at: string; schedule_kind: string; interval_ms: number }>;
    expect(triggers).toHaveLength(1);
    expect(triggers[0].next_run_at).toBe('2026-08-15T01:00:00.000Z'); // 上海明天 09:00
    expect(triggers[0].schedule_kind).toBe('daily');
    expect(triggers[0].interval_ms).toBe(86_400_000); // CHECK 约束兜底

    // 到期派发后 next = 再下一次（同刻 +1 天）
    const dispatched = dispatchDueScheduleTriggers(db, new Date('2026-08-15T01:00:00.000Z'));
    expect(dispatched).toHaveLength(1);
    const after = db.prepare('SELECT next_run_at FROM trigger').get() as { next_run_at: string };
    expect(after.next_run_at).toBe('2026-08-16T01:00:00.000Z');
  });

  it('注册校验：timeOfDay 与 intervalMs 互斥、时区必须有效、scope 二选一', () => {
    const { project } = makeCompanyFixture();
    expect(() => registerScheduleTrigger(db, {
      projectId: project.id, timeOfDay: '09:00', intervalMs: 60_000, template: {},
    })).toThrow(AppError);
    expect(() => registerScheduleTrigger(db, {
      projectId: project.id, timeOfDay: '09:00', timezone: 'Mars/Olympus', template: {},
    })).toThrow(/无效时区/);
    expect(() => registerScheduleTrigger(db, { intervalMs: 60_000, template: {} })).toThrow(/至少提供其一/);
  });
});

describe('防叠跑护栏', () => {
  it('上次派发的 Task 仍在运行 → 本轮跳过、next_run_at 推进、旧任务留 trigger_skipped_overlap 事件', () => {
    const { company, lead, project } = makeCompanyFixture();
    const projectTask = createProjectTask(db, { projectId: project.id, title: '巡检' });
    registerScheduleTrigger(db, {
      projectId: project.id,
      intervalMs: 60_000,
      template: { title: '巡检', projectTaskId: projectTask.id },
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const first = dispatchDueScheduleTriggers(db, new Date('2026-01-01T00:01:00.000Z'));
    expect(first).toHaveLength(1);
    const firstTask = getTask(db, first[0]);
    // 模拟第一轮任务还在运行
    setTaskState(db, firstTask.id, 'running');

    const second = dispatchDueScheduleTriggers(db, new Date('2026-01-01T00:02:00.000Z'));
    expect(second).toEqual([]);
    expect(listTasks(db, project.id)).toHaveLength(1); // 没有堆积第二个任务
    const after = db.prepare('SELECT next_run_at FROM trigger').get() as { next_run_at: string };
    expect(after.next_run_at).toBe('2026-01-01T00:03:00.000Z'); // next 已推进
    const events = listTaskEvents(db, firstTask.id);
    expect(events.some((event) => event.kind === 'trigger_skipped_overlap')).toBe(true);
  });

  it('上次任务已终态 → 正常派发新一轮', () => {
    const { project } = makeCompanyFixture();
    const projectTask = createProjectTask(db, { projectId: project.id, title: '巡检' });
    registerScheduleTrigger(db, {
      projectId: project.id,
      intervalMs: 60_000,
      template: { title: '巡检', projectTaskId: projectTask.id },
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const first = dispatchDueScheduleTriggers(db, new Date('2026-01-01T00:01:00.000Z'));
    setTaskState(db, first[0], 'completed');

    const second = dispatchDueScheduleTriggers(db, new Date('2026-01-01T00:02:00.000Z'));
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    expect(listTasks(db, project.id)).toHaveLength(2);
  });
});

describe('once（一次性：倒计时/指定时刻）触发器（批次三）', () => {
  it('到点执行一次即停（enabled=0），未指定执行人默认派负责人', () => {
    const { project, lead } = makeCompanyFixture();
    const projectTask = createProjectTask(db, { projectId: project.id, title: '提醒' });
    registerScheduleTrigger(db, {
      projectId: project.id,
      runAt: '2026-01-01T08:30:00.000Z',
      template: { title: '倒计时提醒', projectTaskId: projectTask.id },
      now: new Date('2026-01-01T08:00:00.000Z'),
    });
    const row = db.prepare('SELECT schedule_kind, interval_ms, next_run_at, enabled FROM trigger').get() as
      { schedule_kind: string; interval_ms: number; next_run_at: string; enabled: number };
    expect(row.schedule_kind).toBe('once');
    expect(row.next_run_at).toBe('2026-01-01T08:30:00.000Z');
    expect(row.interval_ms).toBe(30 * 60_000); // 倒计时延迟留档（手动重启=重开倒计时）

    // 未到点不派发
    expect(dispatchDueScheduleTriggers(db, new Date('2026-01-01T08:29:00.000Z'))).toEqual([]);

    // 到点：派发一次 + 执行即停 + 默认派负责人
    const dispatched = dispatchDueScheduleTriggers(db, new Date('2026-01-01T08:31:00.000Z'));
    expect(dispatched).toHaveLength(1);
    const task = getTask(db, dispatched[0]);
    expect(task.title).toBe('[计划] 倒计时提醒');
    expect(task.assigneeAgentId).toBe(lead.id);
    const after = db.prepare('SELECT enabled FROM trigger').get() as { enabled: number };
    expect(after.enabled).toBe(0);

    // 之后任何时刻不再派发（一次性）
    setTaskState(db, task.id, 'completed');
    expect(dispatchDueScheduleTriggers(db, new Date('2026-01-02T00:00:00.000Z'))).toEqual([]);
    expect(listTasks(db, project.id)).toHaveLength(1);
  });

  it('runAt 不晚于 now 时拒绝注册', () => {
    const { project } = makeCompanyFixture();
    const projectTask = createProjectTask(db, { projectId: project.id, title: '提醒' });
    expect(() => registerScheduleTrigger(db, {
      projectId: project.id,
      runAt: '2026-01-01T00:00:00.000Z',
      template: { title: '过去时刻', projectTaskId: projectTask.id },
      now: new Date('2026-01-01T08:00:00.000Z'),
    })).toThrow(AppError);
  });

  it('防叠跑不顺延一次性计划：上一任务终态后下一轮立即补发', () => {
    const { project } = makeCompanyFixture();
    const projectTask = createProjectTask(db, { projectId: project.id, title: '提醒' });
    registerScheduleTrigger(db, {
      projectId: project.id,
      runAt: '2026-01-01T01:00:00.000Z',
      template: { title: '补发提醒', projectTaskId: projectTask.id },
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    // 首发后手动重新启用（模拟"再来一次倒计时"被拦在上一任务仍跑时）
    const first = dispatchDueScheduleTriggers(db, new Date('2026-01-01T01:01:00.000Z'));
    expect(first).toHaveLength(1);
    db.prepare('UPDATE trigger SET enabled=1, next_run_at=? WHERE kind=\'schedule\'').run('2026-01-01T01:01:00.000Z');
    setTaskState(db, first[0], 'running');

    // 旧任务在跑：跳过但 next_run_at 不推进（保持到期，不能把一次性计划无限顺延）
    expect(dispatchDueScheduleTriggers(db, new Date('2026-01-01T01:02:00.000Z'))).toEqual([]);
    const kept = db.prepare('SELECT next_run_at FROM trigger').get() as { next_run_at: string };
    expect(kept.next_run_at).toBe('2026-01-01T01:01:00.000Z');

    // 旧任务终态 → 下一轮立即补发
    setTaskState(db, first[0], 'completed');
    const second = dispatchDueScheduleTriggers(db, new Date('2026-01-01T01:03:00.000Z'));
    expect(second).toHaveLength(1);
  });
});

describe('公司级触发器', () => {
  it('公司还没有项目时不派发且不推进 next_run_at；有项目后派发给负责人', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_2', name: 'co' });
    const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
    updateCompanyFirstAgent(company.id, lead.id);
    clockIn(db);
    registerScheduleTrigger(db, {
      companyId: company.id,
      intervalMs: 60_000,
      template: { title: '每日公司日报' },
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    // 公司无项目：不派发、不消费本轮
    expect(dispatchDueScheduleTriggers(db, new Date('2026-01-01T00:01:00.000Z'))).toEqual([]);
    let row = db.prepare('SELECT next_run_at FROM trigger').get() as { next_run_at: string };
    expect(row.next_run_at).toBe('2026-01-01T00:01:00.000Z'); // 未推进

    // 建项目后立即补发
    const project = createProject(db, {
      companyId: company.id,
      name: 'p1',
      rootDir: '/tmp/company-schedule',
      firstAgentId: lead.id,
      initialState: 'active',
    });
    const dispatched = dispatchDueScheduleTriggers(db, new Date('2026-01-01T00:01:30.000Z'));
    expect(dispatched).toHaveLength(1);
    const task = getTask(db, dispatched[0]);
    expect(task.title).toBe('[计划] 每日公司日报');
    expect(task.assigneeAgentId).toBe(lead.id);
    expect(task.projectId).toBe(project.id);
    expect((task.inputProtocol as Record<string, unknown>).scope).toBe('company');
    // last_task_id 已登记（供防叠跑使用）
    row = db.prepare('SELECT next_run_at, last_task_id FROM trigger').get() as { next_run_at: string; last_task_id: string };
    expect(row.last_task_id).toBe(task.id);
    expect(row.next_run_at).toBe('2026-01-01T00:02:30.000Z');
  });

  it('公司级 daily 触发器 + 管理面（list/启停/删除）', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_3', name: 'co' });
    const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
    updateCompanyFirstAgent(company.id, lead.id);
    clockIn(db);
    registerScheduleTrigger(db, {
      companyId: company.id,
      timeOfDay: '09:00',
      timezone: 'UTC',
      template: { title: '晨报' },
      now: new Date('2026-08-14T10:00:00.000Z'),
    });

    const list = listCompanyTriggers(db, company.id);
    expect(list).toHaveLength(1);
    expect(list[0].scheduleKind).toBe('daily');
    expect(list[0].timeOfDay).toBe('09:00');
    expect(list[0].projectId).toBeNull();

    const paused = setCompanyTriggerEnabled(db, company.id, list[0].id, false);
    expect(paused.enabled).toBe(false);
    // 停用后重新启用会按真实时钟重算下一个 09:00 UTC（测试不得硬编码日期——否则过时即挂）
    const resumed = setCompanyTriggerEnabled(db, company.id, list[0].id, true);
    expect(resumed.enabled).toBe(true);
    const next = new Date(Date.now());
    next.setUTCHours(9, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
    expect(resumed.nextRunAt).toBe(next.toISOString());

    deleteCompanyTrigger(db, company.id, list[0].id);
    expect(listCompanyTriggers(db, company.id)).toHaveLength(0);
    expect(() => deleteCompanyTrigger(db, company.id, list[0].id)).toThrow();
  });
});


/** 测试助手：直接改任务状态（模拟引擎运行/完成）。 */
function setTaskState(db: DB, id: string, state: string): void {
  db.prepare('UPDATE task SET state=? WHERE id=?').run(state, id);
}

/** 测试助手：设置公司负责人（createCompany 不支持直接传）。 */
function updateCompanyFirstAgent(companyId: string, agentId: string): void {
  db.prepare('UPDATE workbench SET first_agent_id=? WHERE id=?').run(agentId, companyId);
}
