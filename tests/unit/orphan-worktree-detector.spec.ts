import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { saveTaskRuntime, getTaskRuntime } from '../../src/server/domain/task-runtime';
import { ensureGitRepo, createWorktree, worktreeRoot, detectOrphanWorktrees, cleanOrphanWorktrees } from '../../src/server/worktree/manager';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('孤儿工作树检测与清理（批次 H）', () => {
  it('detectOrphanWorktrees 识别未注册或已结束任务的孤儿 worktree', () => {
    const rootDir = `/tmp/muster-test-orphan-${Date.now()}`;
    mkdirSync(rootDir, { recursive: true });
    ensureGitRepo(rootDir);

    const workbench = restoreWorkbench(db, { id: 'wb_orphan_1', name: '工作台' });
    const project = createProject(db, {
      companyId: workbench.id,
      name: '孤儿测试项目',
      rootDir,
    });

    // 1. 创建合法任务 A（未达终态，在 runtime 注册）
    const taskA = createTask(db, { projectId: project.id, title: '正常任务 A' });
    const wtA = createWorktree(rootDir, project.id, taskA.id);
    saveTaskRuntime(db, wtA);

    // 2. 创建孤儿目录 B（磁盘上有，但 DB 中没有该 task）
    const fakeTaskId = 'tk_fake_orphan_999';
    const fakeWtDir = join(worktreeRoot(), fakeTaskId);
    mkdirSync(fakeWtDir, { recursive: true });
    writeFileSync(join(fakeWtDir, 'test.txt'), 'orphan content');

    // 3. 创建已结束且非 manual 审核的任务 C，但 worktree 未回收
    const taskC = createTask(db, { projectId: project.id, title: '已取消的任务 C', mergeMode: 'auto' });
    const wtC = createWorktree(rootDir, project.id, taskC.id);
    saveTaskRuntime(db, wtC);
    db.prepare("UPDATE task SET state='cancelled' WHERE id=?").run(taskC.id);

    // 4. 执行检测
    const orphans = detectOrphanWorktrees(db, rootDir, project.id);
    const orphanTaskIds = orphans.map((o) => o.taskId);

    expect(orphanTaskIds).toContain(fakeTaskId);
    expect(orphanTaskIds).toContain(taskC.id);
    expect(orphanTaskIds).not.toContain(taskA.id);

    // 5. 执行清理
    const cleanRes = cleanOrphanWorktrees(db, rootDir, project.id);
    expect(cleanRes.cleanedCount).toBeGreaterThanOrEqual(2);

    // 6. 验证清理后孤儿目录不复存在
    expect(existsSync(fakeWtDir)).toBe(false);
    expect(getTaskRuntime(db, taskC.id)).toBeUndefined();
    expect(getTaskRuntime(db, taskA.id)).toBeDefined();
  });
});
