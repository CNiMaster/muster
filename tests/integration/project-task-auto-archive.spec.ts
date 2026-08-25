/**
 * R2b 任务自动归档（合并计划 2026-08-25-network-retry-progress-recovery-plan.md）：
 * - listProjectTasks 默认排除 archived；includeArchived 取全量
 * - archiveStaleCompletedTasks：超期 completed 归档（级联语义复用）、未到期/active/关闭不动、单次上限
 * - 设置键 archiveTaskAfterDays：默认 30、保存读回、0=关闭
 */
import { describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask, completeProjectTask, listProjectTasks, archiveStaleCompletedTasks } from '../../src/server/domain/project-task';
import { getSystemSettings, saveSystemSettings } from '../../src/server/domain/setting';

function setup() {
  const { db, close } = makeTestDb();
  const company = restoreWorkbench(db, { id: 'wb_r2b', name: '公司' });
  const project = createProject(db, { companyId: company.id, name: '项目', rootDir: '/tmp/r2b', initialState: 'active' });
  return { db, close, project };
}

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);

describe('listProjectTasks 归档过滤（R2b）', () => {
  it('默认排除 archived；includeArchived=true 取全量', () => {
    const { db, close, project } = setup();
    try {
      const active = createProjectTask(db, { projectId: project.id, title: '进行中' });
      const done = createProjectTask(db, { projectId: project.id, title: '已完成' });
      completeProjectTask(db, done.id);
      const archived = createProjectTask(db, { projectId: project.id, title: '已归档' });
      completeProjectTask(db, archived.id);
      archiveProjectTaskSafe(db, archived.id);

      const names = (list: Array<{ title: string }>) => list.map((t) => t.title);
      expect(names(listProjectTasks(db, project.id))).toEqual(['已完成', '进行中']); // 排除 archived（pinned/sort 序）
      expect(names(listProjectTasks(db, project.id, { includeArchived: true }))).toContain('已归档');
      expect(listProjectTasks(db, project.id, { includeArchived: true })).toHaveLength(3);
      expect(active.state).toBe('active');
    } finally { close(); }
  });
});

describe('archiveStaleCompletedTasks（R2b）', () => {
  it('超期 completed 被归档；未到期与 active 不动；days=0 关闭', () => {
    const { db, close, project } = setup();
    try {
      const old = createProjectTask(db, { projectId: project.id, title: '老任务' });
      completeProjectTask(db, old.id);
      db.prepare('UPDATE project_task SET completed_at=? WHERE id=?').run(daysAgo(40).toISOString(), old.id);
      const fresh = createProjectTask(db, { projectId: project.id, title: '新完成任务' });
      completeProjectTask(db, fresh.id);
      const running = createProjectTask(db, { projectId: project.id, title: '进行中很老' });
      db.prepare('UPDATE project_task SET updated_at=? WHERE id=?').run(daysAgo(90).toISOString(), running.id);

      const archived = archiveStaleCompletedTasks(db, 30, new Date());
      expect(archived).toEqual([old.id]);
      expect(db.prepare("SELECT state FROM project_task WHERE id=?").get(old.id)).toEqual({ state: 'archived' });
      expect(db.prepare("SELECT state FROM project_task WHERE id=?").get(fresh.id)).toEqual({ state: 'completed' });
      expect(db.prepare("SELECT state FROM project_task WHERE id=?").get(running.id)).toEqual({ state: 'active' });

      // 关闭：days=0 直接返回空且不动数据
      expect(archiveStaleCompletedTasks(db, 0, new Date())).toEqual([]);
    } finally { close(); }
  });

  it('单次上限 maxBatch 防长事务（分批消化）', () => {
    const { db, close, project } = setup();
    try {
      for (let i = 0; i < 5; i++) {
        const t = createProjectTask(db, { projectId: project.id, title: `超期${i}` });
        completeProjectTask(db, t.id);
        db.prepare('UPDATE project_task SET completed_at=? WHERE id=?').run(daysAgo(60).toISOString(), t.id);
      }
      const first = archiveStaleCompletedTasks(db, 30, new Date(), 2);
      expect(first).toHaveLength(2);
      const second = archiveStaleCompletedTasks(db, 30, new Date(), 2);
      expect(second).toHaveLength(2);
      const third = archiveStaleCompletedTasks(db, 30, new Date(), 2);
      expect(third).toHaveLength(1);
    } finally { close(); }
  });
});

describe('设置键 archiveTaskAfterDays（R2b）', () => {
  it('默认 30；保存 7 读回 7；保存 0 读回 0（关闭）', () => {
    const { db, close } = makeTestDb();
    try {
      expect(getSystemSettings(db).archiveTaskAfterDays).toBe(30);
      saveSystemSettings(db, { archiveTaskAfterDays: 7 });
      expect(getSystemSettings(db).archiveTaskAfterDays).toBe(7);
      saveSystemSettings(db, { archiveTaskAfterDays: 0 });
      expect(getSystemSettings(db).archiveTaskAfterDays).toBe(0);
    } finally { close(); }
  });
});

function archiveProjectTaskSafe(db: Parameters<typeof archiveStaleCompletedTasks>[0], id: string): void {
  db.prepare("UPDATE project_task SET state='archived', archived_at=? WHERE id=?").run(new Date().toISOString(), id);
}
