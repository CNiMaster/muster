/**
 * 任务工作区共享仓库环境（2026-08-28，设置 worktree_share_env 默认开）：
 * - linkWorktreeEnv：主仓有 node_modules 且工作区无 → 软链（不复制）；已存在不覆盖；主仓无 → 不链
 * - 变更清单排除：软链 node_modules 不进 listTaskBranchChanges / listTaskBranchChangeStatus
 *   （防发布清单「新增 node_modules」噪音 + 白名单外守护误报）；真实目录维持原行为照列
 * - commitAll 防线：软链不进集成分支提交（git add -A 会把链接本身作为条目）；真实目录照常提交
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureGitRepo, createWorktree, linkWorktreeEnv, removeWorktree,
  listTaskBranchChanges, listTaskBranchChangeStatus, commitAll,
} from '../../src/server/worktree/manager';

let root: string;

function git(dir: string, args: string[]): string {
  return execSync(`git ${args.map((a) => `'${a}'`).join(' ')}`, { cwd: dir, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'muster-wt-env-'));
  process.env.MUSTER_HOME = path.join(root, '.muster-home');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
});

/** 主仓带 node_modules 的基线仓库 + 首个提交。 */
function seedRepo(): void {
  ensureGitRepo(root);
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'node_modules', 'pkg.json'), '{"name":"fixture"}');
  writeFileSync(path.join(root, 'README.md'), 'base');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'base']);
}

describe('worktree 共享环境：linkWorktreeEnv', () => {
  it('主仓有依赖且工作区无 → 软链直通；重复调用不覆盖', () => {
    seedRepo();
    const wt = createWorktree(root, 'prj_env', 'task_link');
    expect(linkWorktreeEnv(root, wt.path)).toBe(true);
    expect(lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink()).toBe(true);
    // 链接直通：能读到主仓依赖内容
    expect(readFileSync(path.join(wt.path, 'node_modules', 'pkg.json'), 'utf8')).toContain('fixture');
    // 已存在（无论真假）不覆盖：二次调用 false 且链接不变
    expect(linkWorktreeEnv(root, wt.path)).toBe(false);
    expect(lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it('工作区已有真实 node_modules → 不链不动；主仓无依赖 → false', () => {
    seedRepo();
    const wtReal = createWorktree(root, 'prj_env', 'task_real');
    mkdirSync(path.join(wtReal.path, 'node_modules'));
    writeFileSync(path.join(wtReal.path, 'node_modules', 'own.txt'), 'own');
    expect(linkWorktreeEnv(root, wtReal.path)).toBe(false);
    expect(lstatSync(path.join(wtReal.path, 'node_modules')).isSymbolicLink()).toBe(false);

    const rootBare = mkdtempSync(path.join(tmpdir(), 'muster-wt-env-bare-'));
    try {
      ensureGitRepo(rootBare);
      writeFileSync(path.join(rootBare, 'a.txt'), 'a');
      git(rootBare, ['add', '-A']);
      git(rootBare, ['commit', '-m', 'base']);
      const wt = createWorktree(rootBare, 'prj_bare', 'task_bare');
      expect(linkWorktreeEnv(rootBare, wt.path)).toBe(false);
      expect(existsSync(path.join(wt.path, 'node_modules'))).toBe(false);
    } finally {
      rmSync(rootBare, { recursive: true, force: true });
    }
  });
});

describe('worktree 共享环境：变更清单排除软链', () => {
  it('软链 node_modules 不进守护清单与发布分类；真实目录照列（原行为不动）', () => {
    seedRepo();
    // 软链路：链接 + 一条真实改动
    const wtLink = createWorktree(root, 'prj_env', 'task_cls_link');
    expect(linkWorktreeEnv(root, wtLink.path)).toBe(true);
    writeFileSync(path.join(wtLink.path, 'draft.txt'), '真实改动');
    const guardLink = listTaskBranchChanges(root, wtLink);
    expect(guardLink.uncommitted).toContain('draft.txt');
    expect(guardLink.uncommitted).not.toContain('node_modules');
    const statusLink = listTaskBranchChangeStatus(root, wtLink);
    expect(statusLink.some((c) => c.path === 'draft.txt')).toBe(true);
    expect(statusLink.some((c) => c.path === 'node_modules')).toBe(false);

    // 真实目录路：用户仓库自己的依赖（未 gitignore）照旧出现在清单里
    const wtReal = createWorktree(root, 'prj_env', 'task_cls_real');
    mkdirSync(path.join(wtReal.path, 'node_modules'));
    writeFileSync(path.join(wtReal.path, 'node_modules', 'own.txt'), 'own');
    const guardReal = listTaskBranchChanges(root, wtReal);
    expect(guardReal.uncommitted.some((p) => p.startsWith('node_modules'))).toBe(true);
  });
});

describe('worktree 共享环境：commitAll 发布防线', () => {
  it('软链不进集成分支提交；真实目录维持原行为提交', () => {
    seedRepo();
    // 软链路：提交只含真实改动
    const wtLink = createWorktree(root, 'prj_env', 'task_ca_link');
    expect(linkWorktreeEnv(root, wtLink.path)).toBe(true);
    writeFileSync(path.join(wtLink.path, 'result.txt'), '成果');
    const shaLink = commitAll(wtLink.path, 'feat: 成果');
    const committedLink = git(wtLink.path, ['show', '--name-only', '--pretty=format:', shaLink]).split('\n').filter(Boolean);
    expect(committedLink).toContain('result.txt');
    expect(committedLink.some((p) => p === 'node_modules' || p.startsWith('node_modules/'))).toBe(false);

    // 真实目录路：用户仓库自己的依赖照常进提交
    const wtReal = createWorktree(root, 'prj_env', 'task_ca_real');
    mkdirSync(path.join(wtReal.path, 'node_modules'));
    writeFileSync(path.join(wtReal.path, 'node_modules', 'own.txt'), 'own');
    const shaReal = commitAll(wtReal.path, 'feat: 自带依赖');
    const committedReal = git(wtReal.path, ['show', '--name-only', '--pretty=format:', shaReal]).split('\n').filter(Boolean);
    expect(committedReal.some((p) => p.startsWith('node_modules'))).toBe(true);
  });
});

describe('worktree 共享环境：removeWorktree 摘链防线', () => {
  it('删除前先摘软链：主仓 node_modules 分毫不动，worktree 目录移除', () => {
    seedRepo();
    const wt = createWorktree(root, 'prj_env', 'task_rm_link');
    expect(linkWorktreeEnv(root, wt.path)).toBe(true);
    writeFileSync(path.join(wt.path, 'draft.txt'), '草稿');
    removeWorktree(root, wt);
    // 主仓依赖完好（防线目标）；worktree 目录已随 git remove 消失
    expect(readFileSync(path.join(root, 'node_modules', 'pkg.json'), 'utf8')).toContain('fixture');
    expect(existsSync(wt.path)).toBe(false);
    expect(lstatSync(path.join(root, 'node_modules')).isSymbolicLink()).toBe(false);
  });

  it('真实 node_modules 目录走原行为（不预摘），删除照常完成', () => {
    seedRepo();
    const wt = createWorktree(root, 'prj_env', 'task_rm_real');
    mkdirSync(path.join(wt.path, 'node_modules'));
    writeFileSync(path.join(wt.path, 'node_modules', 'own.txt'), 'own');
    removeWorktree(root, wt);
    expect(existsSync(wt.path)).toBe(false);
    expect(readFileSync(path.join(root, 'node_modules', 'pkg.json'), 'utf8')).toContain('fixture');
  });
});
