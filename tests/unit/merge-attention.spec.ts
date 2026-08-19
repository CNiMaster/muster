/**
 * 搁置提醒兜底（用户定案 2026-08-19）：manual 默认下任务集成区领先 ≥5h 未合并 → 红点；
 * 孤儿 worktree 恒计入 attention（永不自动合并）。getMergeAttention = 右侧分栏聚合徽标 + 待合并导航项数据源。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import {
  ensureTaskStagingWorktree, ensureGitRepo, commitAll,
} from '../../src/server/worktree/manager';
import { listPendingTaskMerges, getMergeAttention, STALE_MERGE_HOURS } from '../../src/server/domain/staging';

let tmp: string;
let db: DB;

function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout).trim();
}

function addPt(projectId: string, seq: number): string {
  const id = `pt_att${seq}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare("INSERT INTO project_task (id, project_id, seq, title, state, created_at, updated_at) VALUES (?,?,?,'任务','active',?,?)")
    .run(id, projectId, seq, new Date().toISOString(), new Date().toISOString());
  return id;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'muster-att-'));
  process.env.MUSTER_HOME = path.join(tmp, 'muster-home');
  db = makeTestDb().db;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
});

describe('搁置提醒兜底（≥5h 红点）', () => {
  it('新鲜领先不提醒；搁置 ≥5h 计入 staleHours 与 attention；无领先不计', () => {
    expect(STALE_MERGE_HOURS).toBe(5);
    const workbench = restoreWorkbench(db, { id: 'wb_att', name: '工作台' });
    const project = createProject(db, { companyId: workbench.id, name: '项目', initialState: 'active' });
    mkdirSync(project.rootDir, { recursive: true });
    ensureGitRepo(project.rootDir);
    writeFileSync(path.join(project.rootDir, 'base.txt'), 'base');
    git(project.rootDir, ['add', '-A']);
    git(project.rootDir, ['commit', '-m', 'base']);

    // pt1：新鲜领先（正常时钟）→ staleHours null
    const pt1 = addPt(project.id, 1);
    const s1 = ensureTaskStagingWorktree(project.rootDir, project.id, pt1);
    writeFileSync(path.join(s1.path, 'fresh.txt'), 'x');
    git(s1.path, ['add', '-A']);
    git(s1.path, ['commit', '-m', 'fresh']);

    // pt2：搁置 6 小时（GIT_COMMITTER_DATE 回拨提交时间）
    const pt2 = addPt(project.id, 2);
    const s2 = ensureTaskStagingWorktree(project.rootDir, project.id, pt2);
    writeFileSync(path.join(s2.path, 'stale.txt'), 'x');
    git(s2.path, ['add', '-A']);
    const staleDate = new Date(Date.now() - 6 * 3_600_000).toISOString();
    git(s2.path, ['commit', '-m', 'stale'], { GIT_COMMITTER_DATE: staleDate, GIT_AUTHOR_DATE: staleDate });

    const items = listPendingTaskMerges(db, project.id);
    const byPt = new Map(items.map((i) => [i.projectTaskId, i]));
    expect(byPt.get(pt1)!.staleHours).toBeNull();
    expect(byPt.get(pt2)!.staleHours).not.toBeNull();
    expect(byPt.get(pt2)!.staleHours!).toBeGreaterThanOrEqual(5);

    const attention = getMergeAttention(db, project.id);
    expect(attention.staleMerges).toBe(1);
    expect(attention.orphans).toBe(0); // staging worktree（pt- 前缀）不算孤儿
    expect(attention.total).toBe(1);
  });

  it('孤儿 worktree 恒计入 attention（永不自动合并，本身就是待处理异常）', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_att2', name: '工作台' });
    const project = createProject(db, { companyId: workbench.id, name: '项目', initialState: 'active' });
    mkdirSync(project.rootDir, { recursive: true });
    ensureGitRepo(project.rootDir);
    writeFileSync(path.join(project.rootDir, 'base.txt'), 'base');
    git(project.rootDir, ['add', '-A']);
    git(project.rootDir, ['commit', '-m', 'base']);
    // 用户自建 worktree（未登记）
    const home = process.env.MUSTER_HOME ?? '';
    execSync(`mkdir -p "${home}/worktrees"`, { shell: '/bin/sh' });
    git(project.rootDir, ['worktree', 'add', '--detach', path.join(home, 'worktrees', 'user-wt')]);

    const attention = getMergeAttention(db, project.id);
    expect(attention.orphans).toBe(1);
    expect(attention.total).toBe(1);
  });
});
