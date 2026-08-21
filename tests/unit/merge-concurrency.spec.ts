/**
 * 合并并发收口 + 分叉可见性 + 合并预演（2026-08-21 计划批次 1-3）。
 * - 批次1：同一任务双发起 promote（UI+看门狗）→ in-flight 去重，一路成功一路跳过；收敛后重跑 → 暂无待合并
 * - 批次2：behindCommits——主干前进 N 提交后看板行可见分叉
 * - 批次3：merge-tree 预演——同区域双改预测冲突文件；不重叠干净；behind=0 不预演
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { promoteTaskStaging, listPendingTaskMerges } from '../../src/server/domain/staging';
import { ensureGitRepo, ensureTaskStagingWorktree } from '../../src/server/worktree/manager';

let tmp: string;
let db: DB;

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout).trim();
}

beforeEach(() => {
  vi.restoreAllMocks();
  tmp = mkdtempSync(path.join(tmpdir(), 'muster-mc-'));
  process.env.MUSTER_HOME = path.join(tmp, 'muster-home');
  db = makeTestDb().db;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
});

/** 建一个集成分支领先 1 提交的业务项目（promote/看板夹具）。stagingContent 可定制集成分支上的文件内容。 */
function fixturePendingStaging(tag: string, stagingContent: Record<string, string> = { 'out.txt': 'result\n' }): {
  projectId: string; ptId: string; rootDir: string;
} {
  const workbench = restoreWorkbench(db, { id: `wb_mc_${tag}`, name: '工作台' });
  const rootDir = path.join(tmp, `repo-${tag}`);
  const projectId = createProject(db, { companyId: workbench.id, name: '项目', initialState: 'active', rootDir }).id;
  mkdirSync(rootDir, { recursive: true });
  ensureGitRepo(rootDir);
  writeFileSync(path.join(rootDir, 'base.txt'), 'base\n');
  git(rootDir, ['add', '-A']);
  git(rootDir, ['commit', '-m', 'base']);
  const ptId = `pt_mc${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO project_task (id, project_id, seq, title, state, created_at, updated_at) VALUES (?,?,1,'集成','active',?,?)").run(ptId, projectId, now, now);
  const staging = ensureTaskStagingWorktree(rootDir, projectId, ptId);
  for (const [file, content] of Object.entries({ 'base.txt': 'base\n', ...stagingContent })) {
    writeFileSync(path.join(staging.path, file), content);
  }
  git(staging.path, ['add', '-A']);
  git(staging.path, ['commit', '-m', 'wip']);
  return { projectId, ptId, rootDir };
}

function mockReviewApprove(delayMs = 0): void {
  vi.spyOn(llmCallModule, 'callLlm').mockImplementation(async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return { content: JSON.stringify({ verdict: 'approve', reason: '安全', summary: '摘要' }) } as never;
  });
}

describe('批次1：promote in-flight 去重', () => {
  it('UI+看门狗同时双发 → 一路成功一路「正在进行中」；收敛后重跑 → 暂无待合并；promoted 只记一条', async () => {
    const f = fixturePendingStaging('race');
    mockReviewApprove(80); // 拉开审查 await 窗口：双发都在窗口内通过领先检查（原竞态现场）
    const [a, b] = await Promise.all([
      promoteTaskStaging(db, f.projectId, f.ptId, { actor: 'ui' }),
      promoteTaskStaging(db, f.projectId, f.ptId, { actor: 'watchdog' }),
    ]);
    const results = [a, b].sort((x, y) => Number(y.promoted) - Number(x.promoted));
    expect(results[0]!.promoted).toBe(true);
    expect(results[1]!.promoted).toBe(false);
    expect(results[1]!.message).toContain('正在进行中');
    // 收敛后重跑：ahead=0 → 暂无待合并（而非进行中）
    mockReviewApprove();
    const third = await promoteTaskStaging(db, f.projectId, f.ptId, { actor: 'watchdog' });
    expect(third.promoted).toBe(false);
    expect(third.message).toContain('暂无待合并');
    const rows = db.prepare("SELECT COUNT(*) AS n FROM task_merge_record WHERE project_task_id=? AND status='promoted'").get(f.ptId) as { n: number };
    expect(rows.n).toBe(1); // 修复前：第二路 "Already up to date" 也记成功
  });
});

describe('批次2：behind 徽章（分叉可见性）', () => {
  it('主干前进 1 提交 → 看板行 behindCommits=1（ahead 不变）；主干未动 → 0', () => {
    const f = fixturePendingStaging('behind');
    const before = listPendingTaskMerges(db, f.projectId);
    expect(before).toHaveLength(1);
    expect(before[0]!.behindCommits).toBe(0); // 基线未动（fast-forward 场景）
    // 主干前进：模拟另一任务已 promote / 用户在主干直接提交
    writeFileSync(path.join(f.rootDir, 'main-moved.txt'), 'moved\n');
    git(f.rootDir, ['add', '-A']);
    git(f.rootDir, ['commit', '-m', 'main advanced']);
    const after = listPendingTaskMerges(db, f.projectId);
    expect(after[0]!.behindCommits).toBe(1);
    expect(after[0]!.aheadCommits).toBe(1);
  });
});
