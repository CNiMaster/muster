import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from './setup';
import { createNovelCompany } from '../../src/server/domain/novel-template';
import { createProject } from '../../src/server/domain/project';
import { transitionCompany, getCompany } from '../../src/server/domain/company';
import { listThreads } from '../../src/server/domain/thread';
import { listTasks } from '../../src/server/domain/task';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { ProjectRuntimeCoordinator } from '../../src/server/runtime/coordinator';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

describe('ProjectRuntimeCoordinator', () => {
  it('在线项目补齐线程并在空队列时派发一次规划 Task', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: '/tmp/muster-coordinator-online',
    });
    transitionCompany(db, novel.company.id, 'online');
    const engine = new TaskEngine(db, new FakeExecutor().script([]));
    const coordinator = new ProjectRuntimeCoordinator(db, engine);

    await coordinator.tick({ pump: false });

    expect(listThreads(db, project.id)).toHaveLength(5);
    const planning = listTasks(db, project.id).filter((task) => task.title.startsWith('[规划]'));
    expect(planning).toHaveLength(1);
  });

  it('draining 公司没有运行中 Task 时自动下班', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: '/tmp/muster-coordinator-drain',
    });
    transitionCompany(db, novel.company.id, 'online');
    transitionCompany(db, novel.company.id, 'draining');
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()));

    await coordinator.tick({ pump: false });

    expect(getCompany(db, novel.company.id).state).toBe('off');
  });
});
