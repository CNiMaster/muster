/**
 * Phase 7 测试：镜像、监察、复盘、头脑风暴
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {  makeTestDb, createNovelCompany } from './setup';
import type { DB } from '../../src/server/db/client';
import { createProject } from '../../src/server/domain/project';
import { ensurePrimaryThread, createMirror, listThreads, removeMirror, updateThreadState } from '../../src/server/domain/thread';
import { createTask, claimNextTask, listTasks, completeTask, markRunning } from '../../src/server/domain/task';
import { generateInspectorSuggestions } from '../../src/server/domain/inspector';
import { openReportCycle, addReportNote, closeReport, shouldTriggerReport, getReport } from '../../src/server/domain/report';
import { startBrainstorm, interruptActiveBrainstorms } from '../../src/server/domain/brainstorm';
import { dispatchCorrectionTask } from '../../src/server/domain/triggers';
import { getWorkbench } from '../../src/server/domain/workbench';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let fx: ReturnType<typeof setupFixture>;

function setupFixture() {
  const r = createNovelCompany(db, { name: 'co' });
  const project = createProject(db, {
    companyId: r.company.id,
    name: 'novel',
    rootDir: '/tmp/n',
    firstAgentId: r.agents.lead.id,
  });
  return { ...r, project };
}

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  fx = setupFixture();
});

describe('mirror task pool sharing', () => {
  it('镜像与根员工共享 Task 池，但不重复领取', () => {
    const t1 = createTask(db, { projectId: fx.project.id, assigneeAgentId: fx.agents.writer.id, title: 'task1' });
    const t2 = createTask(db, { projectId: fx.project.id, assigneeAgentId: fx.agents.writer.id, title: 'task2' });
    const primary = ensurePrimaryThread(db, fx.project.id, fx.agents.writer.id);
    const m1 = createMirror(db, fx.project.id, fx.agents.writer.id);
    const m2 = createMirror(db, fx.project.id, fx.agents.writer.id);

    const c1 = claimNextTask(db, primary.id)!;
    const c2 = claimNextTask(db, m1.id)!;
    const c3 = claimNextTask(db, m2.id);

    expect([c1.task.id, c2.task.id].sort()).toEqual([t1.id, t2.id].sort());
    expect(c3).toBeNull(); // 没有第三个 task
  });

  it('镜像 thread 与 primary 隔离但 agent 相同', () => {
    const primary = ensurePrimaryThread(db, fx.project.id, fx.agents.writer.id);
    const m = createMirror(db, fx.project.id, fx.agents.writer.id);
    expect(m.kind).toBe('mirror');
    expect(m.agentId).toBe(primary.agentId);
    expect(m.rootThreadId).toBe(primary.id);
    const all = listThreads(db, fx.project.id);
    expect(all.length).toBe(2);
  });

  it('运行中的镜像不能直接注销', () => {
    const mirror = createMirror(db, fx.project.id, fx.agents.writer.id);
    updateThreadState(db, mirror.id, 'running');
    expect(() => removeMirror(db, mirror.id)).toThrow(/完成当前 Task/);
  });
});

describe('inspector suggestions', () => {
  it('拥堵检测：员工 queued >= 5 触发扩容建议', () => {
    for (let i = 0; i < 6; i++) {
      createTask(db, { projectId: fx.project.id, assigneeAgentId: fx.agents.writer.id, title: `t${i}` });
    }
    const suggestions = generateInspectorSuggestions(db, fx.project.id);
    const congestion = suggestions.find((s) => s.kind === 'congestion');
    expect(congestion).toBeDefined();
    expect(congestion!.targetAgentId).toBe(fx.agents.writer.id);
  });

  it('正常状态返回 ok', () => {
    const suggestions = generateInspectorSuggestions(db, fx.project.id);
    expect(suggestions[0].kind).toBe('ok');
  });
});

describe('report cycle', () => {
  it('开启复盘 → 公司进入 review_paused', () => {
    // 先上班
    db.prepare("UPDATE workbench SET state='online' WHERE id=?").run(fx.company.id);
    createTask(db, { projectId: fx.project.id, assigneeAgentId: fx.agents.writer.id, title: 't' });
    const r = openReportCycle(db, { projectId: fx.project.id, triggerKind: 'task_count' });
    expect(r.state).toBe('open');
    expect(getWorkbench(db).state).toBe('review_paused');
  });

  it('添加备注 → 转修正 Task → 关闭', () => {
    db.prepare("UPDATE workbench SET state='online' WHERE id=?").run(fx.company.id);
    const r = openReportCycle(db, { projectId: fx.project.id, triggerKind: 'milestone' });
    addReportNote(db, r.id, '主角名字要统一');
    addReportNote(db, r.id, '伏笔要回收');
    const withNotes = getReport(db, r.id);
    expect(withNotes.userNotes.length).toBe(2);
    expect(withNotes.state).toBe('reviewing');

    const before = listTasks(db, fx.project.id).length;
    closeReport(db, r.id, (note) => {
      dispatchCorrectionTask(db, fx.project.id, { note, sourceCycleSeq: 1 });
    });
    const after = listTasks(db, fx.project.id).length;
    expect(after - before).toBe(2); // 两条备注各派一个修正 Task
    expect(getReport(db, r.id).state).toBe('closed');
  });

  it('shouldTriggerReport：完成数达阈值且无 open 复盘时触发', () => {
    // 批量构造 20 个 completed task（直接 UPDATE 绕过状态机）
    for (let i = 0; i < 20; i++) {
      createTask(db, { projectId: fx.project.id, title: `t${i}` });
    }
    db.prepare("UPDATE task SET state='completed', outcome='completed', completed_at=? WHERE project_id=?")
      .run(new Date().toISOString(), fx.project.id);
    const r = shouldTriggerReport(db, fx.project.id, { taskCountInterval: 20 });
    expect(r.trigger).toBe(true);
    expect(r.kind).toBe('task_count');
  });
});

describe('brainstorm', () => {
  it('项目有活跃 Task 时不启动', () => {
    createTask(db, { projectId: fx.project.id, title: '正式工作' });
    const r = startBrainstorm(db, {
      projectId: fx.project.id,
      topic: '下一卷走向',
      participantAgentIds: [fx.agents.writer.id, fx.agents.plot.id],
    });
    expect(r.state).toBe('skipped');
  });

  it('闲置时启动，is_discussion=true，priority=1', () => {
    const r = startBrainstorm(db, {
      projectId: fx.project.id,
      topic: '新点子',
      participantAgentIds: [fx.agents.writer.id],
    });
    expect(r.state).toBe('started');
    const t = listTasks(db, fx.project.id).find((x) => x.id === r.taskId);
    expect(t?.isDiscussion).toBe(1);
    expect(t?.priority).toBe(1);
  });

  it('正式 Task 到达时打断活跃头脑风暴', () => {
    const r = startBrainstorm(db, {
      projectId: fx.project.id,
      topic: '点子',
      participantAgentIds: [fx.agents.writer.id],
    });
    expect(r.state).toBe('started');
    const interrupted = interruptActiveBrainstorms(db, fx.project.id);
    expect(interrupted).toContain(r.taskId);
    const t = listTasks(db, fx.project.id).find((x) => x.id === r.taskId);
    expect(t?.state).toBe('cancelled');
  });
});
