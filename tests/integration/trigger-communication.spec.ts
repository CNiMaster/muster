import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { clockIn, createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, listTasks } from '../../src/server/domain/task';
import {
  dispatchDueScheduleTriggers,
  registerScheduleTrigger,
} from '../../src/server/domain/triggers';
import { makeTestDb } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

describe('schedule trigger dispatch', () => {
  it('到期后派发一次，未再次到期时不会重复派发', () => {
    const company = createCompany(db, { name: 'co' });
    const inspector = createAgent(db, {
      companyId: company.id,
      name: 'inspector',
      role: 'inspector',
      isInspector: true,
    });
    const project = createProject(db, {
      companyId: company.id,
      name: 'novel',
      rootDir: '/tmp/trigger-test',
      firstAgentId: inspector.id,
    });
    clockIn(db, company.id);
    registerScheduleTrigger(db, {
      projectId: project.id,
      intervalMs: 1_000,
      template: { checkKind: 'continuity' },
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(dispatchDueScheduleTriggers(db, new Date('2026-01-01T00:00:00.999Z'))).toEqual([]);
    expect(dispatchDueScheduleTriggers(db, new Date('2026-01-01T00:00:01.000Z'))).toHaveLength(1);
    expect(dispatchDueScheduleTriggers(db, new Date('2026-01-01T00:00:01.500Z'))).toEqual([]);
    expect(listTasks(db, project.id)).toHaveLength(1);
  });

  it('公司下班时不派发，到期项在上班后补派发', () => {
    const company = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
    const project = createProject(db, {
      companyId: company.id,
      name: 'novel',
      rootDir: '/tmp/trigger-offline-test',
      firstAgentId: lead.id,
    });
    registerScheduleTrigger(db, {
      projectId: project.id,
      intervalMs: 100,
      template: { checkKind: 'omission' },
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(dispatchDueScheduleTriggers(db, new Date('2026-01-01T00:00:01.000Z'))).toEqual([]);
    clockIn(db, company.id);
    expect(dispatchDueScheduleTriggers(db, new Date('2026-01-01T00:00:01.000Z'))).toHaveLength(1);
  });
});

describe('task communication permission', () => {
  it('创建员工时拒绝不存在或不属于本公司的 contactAllow', () => {
    const company = createCompany(db, { name: 'co' });
    const otherCompany = createCompany(db, { name: 'other' });
    const outsider = createAgent(db, {
      companyId: otherCompany.id,
      name: 'outsider',
      role: 'writer',
    });

    expect(() =>
      createAgent(db, {
        companyId: company.id,
        name: 'sender',
        role: 'lead',
        contactAllow: ['writer'],
      }),
    ).toThrow(/联系人/);
    expect(() =>
      createAgent(db, {
        companyId: company.id,
        name: 'sender',
        role: 'lead',
        contactAllow: [outsider.id],
      }),
    ).toThrow(/联系人/);
  });

  it('拒绝 dispatcher 联系 contactAllow 之外的员工', () => {
    const company = createCompany(db, { name: 'co' });
    const sender = createAgent(db, { companyId: company.id, name: 'sender', role: 'lead' });
    const recipient = createAgent(db, { companyId: company.id, name: 'recipient', role: 'writer' });
    const project = createProject(db, {
      companyId: company.id,
      name: 'p',
      rootDir: '/tmp/communication-test',
    });

    expect(() =>
      createTask(db, {
        projectId: project.id,
        dispatcherAgentId: sender.id,
        assigneeAgentId: recipient.id,
        title: '非法派发',
      }),
    ).toThrow(/未授权联系/);
  });

  it('允许 dispatcher 联系 contactAllow 中的员工', () => {
    const company = createCompany(db, { name: 'co' });
    const recipient = createAgent(db, { companyId: company.id, name: 'recipient', role: 'writer' });
    const sender = createAgent(db, {
      companyId: company.id,
      name: 'sender',
      role: 'lead',
      contactAllow: [recipient.id],
    });
    const project = createProject(db, {
      companyId: company.id,
      name: 'p',
      rootDir: '/tmp/communication-allowed-test',
    });

    expect(
      createTask(db, {
        projectId: project.id,
        dispatcherAgentId: sender.id,
        assigneeAgentId: recipient.id,
        title: '合法派发',
      }).assigneeAgentId,
    ).toBe(recipient.id);
  });
});
