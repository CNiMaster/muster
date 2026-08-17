/**
 * staging 集成审查工作区（worktree/manager.ts）：
 * - ensureStagingWorktree：建分支+持久 worktree、幂等、目录丢失重挂载
 * - createWorktree baseRef：staging 模式任务从集成分支切出
 * - promoteStaging：快进合并与冲突 abort 两路
 * - stageStatus：存在性 + 领先提交数
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureGitRepo, createWorktree, ensureStagingWorktree, promoteStaging, stageStatus, worktreeRoot } from '../../src/server/worktree/manager';

let root: string;

function git(dir: string, args: string[]): string {
  return execSync(`git ${args.map((a) => `'${a}'`).join(' ')}`, { cwd: dir, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'muster-staging-'));
  process.env.MUSTER_HOME = path.join(root, '.muster-home');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
});

describe('staging worktree', () => {
  it('ensureStagingWorktree 幂等：建分支+持久 worktree，重复调用不报错', () => {
    ensureGitRepo(root);
    writeFileSync(path.join(root, 'a.txt'), 'hello');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'base']);
    const s1 = ensureStagingWorktree(root, 'prj_1');
    expect(existsSync(s1.path)).toBe(true);
    expect(git(root, ['branch', '--list', 'muster/prj_1/staging'])).toContain('staging');
    const s2 = ensureStagingWorktree(root, 'prj_1');
    expect(s2.path).toBe(s1.path);
    // worktree 目录被外部删除后重挂载
    rmSync(s1.path, { recursive: true, force: true });
    const s3 = ensureStagingWorktree(root, 'prj_1');
    expect(existsSync(s3.path)).toBe(true);
  });

  it('createWorktree 支持 baseRef：从 staging 分支切出且 baseCommit 正确', () => {
    ensureGitRepo(root);
    const staging = ensureStagingWorktree(root, 'prj_1');
    // 在 staging 上产生一次提交
    writeFileSync(path.join(staging.path, 's.txt'), 'staging content');
    git(staging.path, ['add', '-A']);
    git(staging.path, ['commit', '-m', 'staging commit']);
    const info = createWorktree(root, 'prj_1', 'tk_1', `muster/prj_1/staging`);
    expect(info.baseCommit).toBe(git(staging.path, ['rev-parse', 'HEAD']));
    // worktree 里能看到 staging 的内容
    expect(existsSync(path.join(info.path, 's.txt'))).toBe(true);
  });

  it('promoteStaging 快进：staging 内容并入主干', () => {
    ensureGitRepo(root);
    writeFileSync(path.join(root, 'base.txt'), 'base');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'base']);
    const staging = ensureStagingWorktree(root, 'prj_1');
    writeFileSync(path.join(staging.path, 'from-staging.txt'), 'v1');
    git(staging.path, ['add', '-A']);
    git(staging.path, ['commit', '-m', 'staging work']);
    const r = promoteStaging(root, 'prj_1');
    expect(r.promoted).toBe(true);
    expect(existsSync(path.join(root, 'from-staging.txt'))).toBe(true);
    expect(stageStatus(root, 'prj_1').aheadCommits).toBe(0);
  });

  it('promoteStaging 冲突：abort 并返回冲突清单，主干不被污染', () => {
    ensureGitRepo(root);
    writeFileSync(path.join(root, 'f.txt'), 'main v1');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'base']);
    const staging = ensureStagingWorktree(root, 'prj_1');
    // staging 改 f.txt
    writeFileSync(path.join(staging.path, 'f.txt'), 'staging v2');
    git(staging.path, ['add', '-A']);
    git(staging.path, ['commit', '-m', 'staging edit']);
    // 主干也改 f.txt（用户手改）
    writeFileSync(path.join(root, 'f.txt'), 'main v2');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'main edit']);
    const before = git(root, ['rev-parse', 'HEAD']);
    const r = promoteStaging(root, 'prj_1');
    expect(r.promoted).toBe(false);
    expect(r.conflicts).toContain('f.txt');
    // abort 后主干保持原状（HEAD 未动、工作区干净）
    expect(git(root, ['status', '--porcelain'])).toBe('');
    expect(existsSync(path.join(root, 'f.txt'))).toBe(true);
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(before);
  });

  it('stageStatus 反映存在性与领先提交数', () => {
    ensureGitRepo(root);
    expect(stageStatus(root, 'prj_2').exists).toBe(false);
    const staging = ensureStagingWorktree(root, 'prj_2');
    writeFileSync(path.join(staging.path, 'x.txt'), 'x');
    git(staging.path, ['add', '-A']);
    git(staging.path, ['commit', '-m', 'one']);
    expect(stageStatus(root, 'prj_2').exists).toBe(true);
    expect(stageStatus(root, 'prj_2').aheadCommits).toBeGreaterThanOrEqual(1);
  });
});
