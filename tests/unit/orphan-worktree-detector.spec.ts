/**
 * 孤儿工作树检测与清理（批次 H·修复轮）：
 * - detectOrphanWorktrees：git worktree list − task_runtime 登记 − 系统集成区（staging-/pt-）
 * - cleanOrphanWorktrees：**强制内容检测防误删**——有未提交/未合并内容且未 force → blocked 返回内容清单不清删；
 *   无内容或 force → 删 worktree+分支+登记。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { saveTaskRuntime, getTaskRuntime } from '../../src/server/domain/task-runtime';
import {
  ensureGitRepo, createWorktree, worktreeRoot,
  detectOrphanWorktrees, cleanOrphanWorktrees, ensureTaskStagingWorktree,
} from '../../src/server/worktree/manager';

let db: DB;
let tmp: string;

function git(dir: string, args: string[]): string {
  return execSync(['git', ...args].join(' '), { cwd: dir, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  tmp = join(tmpdir(), `muster-orphan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.MUSTER_HOME = join(tmp, 'muster-home');
  db = makeTestDb().db;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
});

describe('孤儿工作树检测与清理（批次 H·修复轮）', () => {
  it('识别未登记 worktree；登记任务与系统集成区不算孤儿；清理无内容孤儿', () => {
    const rootDir = join(tmp, 'repo');
    mkdirSync(rootDir, { recursive: true });
    ensureGitRepo(rootDir);
    writeFileSync(join(rootDir, 'README.md'), '# base\n');
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-m', 'base']);

    const workbench = restoreWorkbench(db, { id: 'wb_orphan_1', name: '工作台' });
    const project = createProject(db, { companyId: workbench.id, name: '项目', rootDir });

    // 登记任务 A（不算孤儿）
    const taskA = createTask(db, { projectId: project.id, title: '正常任务 A' });
    const wtA = createWorktree(rootDir, project.id, taskA.id);
    saveTaskRuntime(db, wtA);

    // 孤儿 B：git worktree 登记但 task_runtime 无记录（用户自建形态——用 git worktree add 造）
    const orphanPath = join(worktreeRoot(), 'user-made-wt');
    git(rootDir, ['worktree', 'add', '--detach', orphanPath]);

    // 任务级集成区（pt- 前缀，不算孤儿）
    ensureTaskStagingWorktree(rootDir, project.id, 'pt_probe_1');

    const orphans = detectOrphanWorktrees(db, rootDir);
    const paths = orphans.map((o) => o.path);
    const orphanPathReal = realpathSync(orphanPath);
    expect(paths).toContain(orphanPathReal);
    expect(paths).not.toContain(wtA.path);
    expect(paths.every((p) => !p.includes('pt-pt_probe_1'))).toBe(true);

    // 无内容孤儿 → 直接清理成功
    const res = cleanOrphanWorktrees(db, rootDir);
    expect(res.cleanedCount).toBe(1);
    expect(existsSync(orphanPath)).toBe(false);
    expect(getTaskRuntime(db, taskA.id)).toBeDefined();
  });

  it('防误删防线：有未提交内容/未合并提交的孤儿默认拒绝清理，force 后才清', () => {
    const rootDir = join(tmp, 'repo2');
    mkdirSync(rootDir, { recursive: true });
    ensureGitRepo(rootDir);
    writeFileSync(join(rootDir, 'README.md'), '# base\n');
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-m', 'base']);

    const workbench = restoreWorkbench(db, { id: 'wb_orphan_2', name: '工作台' });
    const project = createProject(db, { companyId: workbench.id, name: '项目', rootDir });

    // 孤儿：带分支 + 未提交文件 + 领先提交
    const orphanPath = join(worktreeRoot(), 'user-made-wt2');
    git(rootDir, ['worktree', 'add', '-b', 'user/orphan-branch', orphanPath]);
    writeFileSync(join(orphanPath, 'uncommitted.txt'), 'draft');
    writeFileSync(join(orphanPath, 'committed.txt'), 'new');
    git(orphanPath, ['add', 'committed.txt']);
    git(orphanPath, ['config', 'user.email', 't@t']);
    git(orphanPath, ['config', 'user.name', 't']);
    git(orphanPath, ['commit', '-m', 'orphan-work']);

    const detected = detectOrphanWorktrees(db, rootDir);
    expect(detected).toHaveLength(1);
    expect(detected[0]!.uncommittedFiles.length).toBeGreaterThan(0);
    expect(detected[0]!.aheadCommits).toBe(1);

    // 未 force → 拒绝并返回内容清单（复盘 0001 防线）
    const blocked = cleanOrphanWorktrees(db, rootDir);
    expect(blocked.cleanedCount).toBe(0);
    expect(blocked.blocked).toHaveLength(1);
    expect(blocked.blocked[0]!.contents.some((c) => c.includes('未合并提交'))).toBe(true);
    expect(existsSync(orphanPath)).toBe(true);

    // force → 清理
    const forced = cleanOrphanWorktrees(db, rootDir, { force: true });
    expect(forced.cleanedCount).toBe(1);
    expect(existsSync(orphanPath)).toBe(false);
  });
});
