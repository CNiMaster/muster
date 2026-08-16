/**
 * 指挥系统批次1：定时自动化补齐——每天 N 点时刻语义 / 防叠跑 / 公司级触发器 / 晨醒开关。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { clockIn, createCompany } from '../../src/server/domain/company';
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
  const company = createCompany(db, { name: 'co' });
  const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
  const project = createProject(db, {
    companyId: company.id,
    name: 'p1',
    rootDir: '/tmp/schedule-automation',
    firstAgentId: lead.id,
    initialState: 'active',
  });
  clockIn(db, company.id);
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

describe('公司级触发器', () => {
  it('公司还没有项目时不派发且不推进 next_run_at；有项目后派发给第一负责人', () => {
    const company = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
    updateCompanyFirstAgent(company.id, lead.id);
    clockIn(db, company.id);
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
    const company = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
    updateCompanyFirstAgent(company.id, lead.id);
    clockIn(db, company.id);
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
    expect(list[0].companyId).toBe(company.id);

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

/** 测试助手：设置公司第一负责人（createCompany 不支持直接传）。 */
function updateCompanyFirstAgent(companyId: string, agentId: string): void {
  db.prepare('UPDATE company SET first_agent_id=? WHERE id=?').run(agentId, companyId);
}
