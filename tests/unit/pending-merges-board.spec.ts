import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { saveTaskRuntime } from '../../src/server/domain/task-runtime';
import { ensureGitRepo, createWorktree, commitAll } from '../../src/server/worktree/manager';
import { listPendingMerges, promoteTaskMerge } from '../../src/server/domain/staging';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('待合并看板与批量推进（批次 H）', () => {
  it('多个 manual 任务完成并列入看板，支持逐项或批量合并', () => {
    const rootDir = `/tmp/muster-test-board-${Date.now()}`;
    mkdirSync(rootDir, { recursive: true });
    ensureGitRepo(rootDir);
    writeFileSync(join(rootDir, 'README.md'), '# Board Project\n');
    commitAll(rootDir, 'initial');

    const workbench = restoreWorkbench(db, { id: 'wb_board_1', name: '工作台' });
    const project = createProject(db, {
      companyId: workbench.id,
      name: '看板测试项目',
      rootDir,
      defaultMergeMode: 'manual',
    });

    // 1. 创建 2 个 manual 任务并产出不同文件
    const task1 = createTask(db, { projectId: project.id, title: '任务 1: 编写文档', mergeMode: 'manual' });
    const wt1 = createWorktree(rootDir, project.id, task1.id);
    saveTaskRuntime(db, wt1);
    writeFileSync(join(wt1.path, 'DOC.md'), 'docs content');
    commitAll(wt1.path, 'feat: docs');
    db.prepare("UPDATE task SET state='completed', summary='DOC 完成', artifacts_json=? WHERE id=?").run(
      JSON.stringify([{ path: 'DOC.md', kind: 'file', operation: 'create' }]),
      task1.id,
    );

    const task2 = createTask(db, { projectId: project.id, title: '任务 2: 编写工具', mergeMode: 'manual' });
    const wt2 = createWorktree(rootDir, project.id, task2.id);
    saveTaskRuntime(db, wt2);
    writeFileSync(join(wt2.path, 'TOOL.md'), 'tool content');
    commitAll(wt2.path, 'feat: tool');
    db.prepare("UPDATE task SET state='completed', summary='TOOL 完成', artifacts_json=? WHERE id=?").run(
      JSON.stringify([{ path: 'TOOL.md', kind: 'file', operation: 'create' }]),
      task2.id,
    );

    // 2. 看板查询
    const list = listPendingMerges(db, project.id);
    expect(list).toHaveLength(2);

    // 3. 逐项合并任务 1
    const p1 = promoteTaskMerge(db, project.id, task1.id);
    expect(p1.promoted).toBe(true);
    expect(existsSync(join(rootDir, 'DOC.md'))).toBe(true);

    // 4. 看板剩余 1 项
    expect(listPendingMerges(db, project.id)).toHaveLength(1);

    // 5. 合并任务 2
    const p2 = promoteTaskMerge(db, project.id, task2.id);
    expect(p2.promoted).toBe(true);
    expect(existsSync(join(rootDir, 'TOOL.md'))).toBe(true);

    // 6. 看板清空
    expect(listPendingMerges(db, project.id)).toHaveLength(0);
  });
});
