/**
 * 待合并看板数据源（批次 H·修复轮）：listPendingTaskMerges 按项目任务聚合——
 * 多任务各自集成领先各自入板；无领先不显示；manual/auto 模式随项目设置。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject, setProjectMergeMode } from '../../src/server/domain/project';
import { ensureTaskStagingWorktree } from '../../src/server/worktree/manager';
import { listPendingTaskMerges } from '../../src/server/domain/staging';

let root: string;
let db: DB;

function git(dir: string, args: string[]): string {
  return execSync([String.raw`git`, ...args.map((a) => JSON.stringify(a))].join(String.raw` `), { cwd: dir, encoding: String.raw`utf-8` }).trim();
}

function addPt(projectId: string, seq: number, title: string): string {
  const id = `pt_b${seq}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    "INSERT INTO project_task (id, project_id, seq, title, state, created_at, updated_at) VALUES (?,?,?,?, 'active', ?, ?)",
  ).run(id, projectId, seq, title, new Date().toISOString(), new Date().toISOString());
  return id;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'muster-board-'));
  process.env.MUSTER_HOME = path.join(root, '.muster-home');
  db = makeTestDb().db;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
});

describe('待合并看板（批次 H·修复轮）', () => {
  it('多任务各自集成领先各自入板；无领先不显示；auto 项目带 mergeMode 标记', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_board_fix', name: '工作台' });
    const project = createProject(db, { companyId: workbench.id, name: '看板项目', initialState: 'active' });
    mkdirSync(project.rootDir, { recursive: true });
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: project.rootDir });
    writeFileSync(path.join(project.rootDir, 'base.txt'), 'base');
    git(project.rootDir, ['add', '-A']);
    git(project.rootDir, ['commit', '-m', 'base']);

    const pt1 = addPt(project.id, 1, '任务一');
    const pt2 = addPt(project.id, 2, '任务二');
    const pt3 = addPt(project.id, 3, '任务三');

    // pt1 集成分支领先 1；pt2 领先 2；pt3 不建分支
    for (const [pt, files] of [[pt1, ['a.txt']], [pt2, ['b.txt', 'c.txt']]] as const) {
      const staging = ensureTaskStagingWorktree(project.rootDir, project.id, pt);
      // 逐文件一提交：pt1 领先 1，pt2 领先 2
      for (const f of files) {
        writeFileSync(path.join(staging.path, f), 'x');
        git(staging.path, ['add', '-A']);
        git(staging.path, ['commit', '-m', 'wip ' + f]);
      }
    }

    const items = listPendingTaskMerges(db, project.id);
    expect(items).toHaveLength(2);
    const byPt = new Map(items.map((i) => [i.projectTaskId, i]));
    expect(byPt.get(pt1)!.aheadCommits).toBe(1);
    expect(byPt.get(pt2)!.aheadCommits).toBe(2);
    expect(byPt.has(pt3)).toBe(false);
    expect(items.every((i) => i.mergeMode === 'manual')).toBe(true);

    setProjectMergeMode(db, project.id, 'auto');
    expect(listPendingTaskMerges(db, project.id).every((i) => i.mergeMode === 'auto')).toBe(true);
  });
});
