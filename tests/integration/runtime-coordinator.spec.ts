import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from './setup';
import { createNovelCompany } from '../../src/server/domain/novel-template';
import { createProject, updateProject } from '../../src/server/domain/project';
import { transitionCompany, getCompany } from '../../src/server/domain/company';
import { listThreads } from '../../src/server/domain/thread';
import { listTasks } from '../../src/server/domain/task';
import { createTask } from '../../src/server/domain/task';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { ProjectRuntimeCoordinator } from '../../src/server/runtime/coordinator';
import { listReports } from '../../src/server/domain/report';
import { startBrainstorm } from '../../src/server/domain/brainstorm';

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

  it('完成数达到项目阈值后自动进入复盘且不再规划新任务', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: '/tmp/muster-coordinator-review',
    });
    updateProject(db, project.id, { settings: { reviewTaskInterval: 2 } });
    for (let i = 0; i < 2; i++) {
      createTask(db, { projectId: project.id, assigneeAgentId: novel.agents.writer.id, title: `完成${i}` });
    }
    db.prepare("UPDATE task SET state='completed', outcome='completed', completed_at=? WHERE project_id=?")
      .run(new Date().toISOString(), project.id);
    transitionCompany(db, novel.company.id, 'online');
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()));

    await coordinator.tick({ pump: false });

    expect(getCompany(db, novel.company.id).state).toBe('review_paused');
    expect(listReports(db, project.id)).toHaveLength(1);
    expect(listTasks(db, project.id).filter((task) => task.title.startsWith('[规划]'))).toHaveLength(0);
  });

  it('正式 Task 到达后自动结束排队中的头脑风暴', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: '/tmp/muster-coordinator-brainstorm',
    });
    const discussion = startBrainstorm(db, {
      projectId: project.id,
      topic: '下一章方向',
      participantAgentIds: [novel.agents.writer.id],
    });
    createTask(db, {
      projectId: project.id,
      assigneeAgentId: novel.agents.lead.id,
      title: '正式规划任务',
    });
    transitionCompany(db, novel.company.id, 'online');
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()));

    await coordinator.tick({ pump: false });

    expect(listTasks(db, project.id).find((task) => task.id === discussion.taskId)?.state).toBe('completed');
  });
});
