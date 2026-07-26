import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb, makeTempGitRepo } from './setup';
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
import { createProjectTask } from '../../src/server/domain/project-task';

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
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    createProjectTask(db, { projectId: project.id, title: '启动作品' });
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
      rootDir: makeTempGitRepo(),
      initialState: 'active',
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
      rootDir: makeTempGitRepo(),
      initialState: 'active',
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
      rootDir: makeTempGitRepo(),
      initialState: 'active',
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

    expect(listTasks(db, project.id).find((task) => task.id === discussion.taskId)?.state).toBe('cancelled');
  });

  it('正式 Task 到达后中止正在执行的头脑风暴，不允许迟到结果回写', async () => {
    const novel = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: 'book',
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    const discussion = startBrainstorm(db, {
      projectId: project.id,
      topic: '正在讨论',
      participantAgentIds: [novel.agents.writer.id],
    });
    transitionCompany(db, novel.company.id, 'online');
    const fake = new FakeExecutor().script([{
      delayMs: 5_000,
      result: { outcome: 'completed', summary: '迟到结论', outboundTasks: [], artifacts: [] },
    }]);
    const engine = new TaskEngine(db, fake);
    const coordinator = new ProjectRuntimeCoordinator(db, engine);
    await coordinator.tick({ pump: false });
    const thread = listThreads(db, project.id).find((item) => item.agentId === novel.agents.writer.id)!;
    const running = engine.pumpThread(thread.id);
    for (let attempt = 0; attempt < 100 && fake.callCount === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fake.callCount).toBe(1);
    createTask(db, {
      projectId: project.id,
      assigneeAgentId: novel.agents.lead.id,
      title: '紧急正式任务',
    });

    await coordinator.tick({ pump: false });
    await running;

    const interrupted = listTasks(db, project.id).find((task) => task.id === discussion.taskId)!;
    expect(interrupted.state).toBe('cancelled');
    expect(interrupted.summary).not.toContain('迟到结论');
  });
});
