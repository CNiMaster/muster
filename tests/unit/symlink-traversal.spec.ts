/**
 * 软链穿链删除静态检测（2026-08-28，worktreeShareEnv 安全配对）：
 * - rm-through-symlink：cwd/名单里有软链 node_modules 时，rm 引用 `node_modules/...`（子路径/
 *   尾斜杠/glob/绝对路径均穿链）判 delete-outside-project；裸 `rm node_modules`（摘链接本身）放行；
 *   无软链的普通仓库同款命令放行（不误伤正常清理）
 * - find-follow-delete：`find -L ... -delete/-exec rm` always-on（对任意软链都危险）；
 *   无 -L 或无删除动作的 find 放行
 * - realpath-resolved-rm：`rm ... $(realpath/readlink -f ...)` always-on
 * - cd-through-symlink：cd 进软链目录且命令链里有 rm
 * - 集成：classifyCommand 带 cwd 归入 delete-outside-project（HIGH_RISK_ACTIONS 接管审批流）；
 *   mapCliToolRequest 把执行 cwd 透传给分类器
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  detectSymlinkTraversalDeletion, listTopLevelSymlinks,
} from '../../src/server/executors/symlink-traversal';
import { classifyCommand, mapCliToolRequest } from '../../src/server/executors/cli-permission-bridge';

const LINKS = { topSymlinks: ['node_modules'] };
const NO_LINKS = { topSymlinks: [] };

describe('rm-through-symlink（需已知软链）', () => {
  it('穿链形态全拦：子路径/尾斜杠/glob/./前缀', () => {
    for (const cmd of [
      'rm -rf node_modules/*',
      'rm -rf node_modules/.cache',
      'rm -rf node_modules/',
      'rm -rf ./node_modules/*',
      'rm -rf node_modules/**',
      'rm -rf build && rm -rf node_modules/dist',
    ]) {
      const hit = detectSymlinkTraversalDeletion(cmd, LINKS);
      expect(hit, cmd).toMatchObject({ action: 'delete-outside-project', pattern: 'rm-through-symlink' });
    }
  });

  it('绝对路径按 cwd 锚定命中；嵌套 node_modules（真目录）不误伤', () => {
    const wt = '/wt/root';
    const opts = { cwd: wt, topSymlinks: ['node_modules'] };
    expect(detectSymlinkTraversalDeletion(`rm -rf ${wt}/node_modules/pkg`, opts))
      .toMatchObject({ pattern: 'rm-through-symlink' });
    expect(detectSymlinkTraversalDeletion(`cd ${wt}/node_modules && rm -rf ./*`, opts))
      .toMatchObject({ pattern: 'cd-through-symlink' });
    // 嵌套真目录（pnpm 工作区形态）——不在顶层软链爆炸半径，放行
    expect(detectSymlinkTraversalDeletion('rm -rf packages/app/node_modules/x', opts)).toBeNull();
    // cwd 未提供时绝对路径无法归因（相对形态仍拦）
    expect(detectSymlinkTraversalDeletion(`rm -rf ${wt}/node_modules/pkg`, LINKS)).toBeNull();
  });

  it('裸链接名（摘链接本身，安全）与无关命令放行', () => {
    expect(detectSymlinkTraversalDeletion('rm -rf node_modules', LINKS)).toBeNull();
    expect(detectSymlinkTraversalDeletion('rm -rf dist build', LINKS)).toBeNull();
    expect(detectSymlinkTraversalDeletion('ls node_modules/ && rm -rf dist', LINKS)).toBeNull();
    expect(detectSymlinkTraversalDeletion('npm install', LINKS)).toBeNull();
  });

  it('普通仓库（无软链）同款命令放行——不误伤正常依赖清理', () => {
    expect(detectSymlinkTraversalDeletion('rm -rf node_modules/*', NO_LINKS)).toBeNull();
    expect(detectSymlinkTraversalDeletion('rm -rf node_modules/*')).toBeNull();
  });
});

describe('find-follow-delete（always-on）', () => {
  it('-L/--follow + 删除动作拦截', () => {
    expect(detectSymlinkTraversalDeletion('find -L . -name "*.log" -delete', NO_LINKS))
      .toMatchObject({ pattern: 'find-follow-delete' });
    expect(detectSymlinkTraversalDeletion('find . -follow -type f -delete', NO_LINKS))
      .toMatchObject({ pattern: 'find-follow-delete' });
    expect(detectSymlinkTraversalDeletion('find -L . -name x -exec rm {} +', NO_LINKS))
      .toMatchObject({ pattern: 'find-follow-delete' });
  });

  it('无跟链或无删除动作放行', () => {
    expect(detectSymlinkTraversalDeletion('find . -name "*.log" -delete', NO_LINKS)).toBeNull();
    expect(detectSymlinkTraversalDeletion('find -L . -name x', NO_LINKS)).toBeNull();
  });
});

describe('realpath-resolved-rm（always-on）', () => {
  it('realpath/readlink -f 解析结果喂 rm 拦截；解析不喂 rm 放行', () => {
    expect(detectSymlinkTraversalDeletion('rm -rf "$(realpath node_modules)"', NO_LINKS))
      .toMatchObject({ pattern: 'realpath-resolved-rm' });
    expect(detectSymlinkTraversalDeletion('rm -rf $(readlink -f node_modules)', NO_LINKS))
      .toMatchObject({ pattern: 'realpath-resolved-rm' });
    expect(detectSymlinkTraversalDeletion('echo $(realpath node_modules)', NO_LINKS)).toBeNull();
  });
});

describe('cd-through-symlink（需已知软链）', () => {
  it('cd 穿链后链上有 rm 拦截；只读进入放行', () => {
    expect(detectSymlinkTraversalDeletion('cd node_modules && rm -rf ./*', LINKS))
      .toMatchObject({ pattern: 'cd-through-symlink' });
    expect(detectSymlinkTraversalDeletion('cd node_modules && ls -la', LINKS)).toBeNull();
    expect(detectSymlinkTraversalDeletion('cd node_modules && rm -rf ./*', NO_LINKS)).toBeNull();
  });
});

describe('cwd 运行时探测 + classifyCommand 集成', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'muster-symtrav-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('listTopLevelSymlinks：真目录不报、软链报 node_modules', () => {
    mkdirSync(path.join(dir, 'node_modules'));
    expect(listTopLevelSymlinks(dir)).toEqual([]);
    rmSync(path.join(dir, 'node_modules'), { recursive: true });
    const target = path.join(dir, 'target');
    mkdirSync(target);
    symlinkSync(target, path.join(dir, 'node_modules'));
    expect(listTopLevelSymlinks(dir)).toEqual(['node_modules']);
  });

  it('classifyCommand 带 cwd：软链在场 → delete-outside-project；不在场 → run-command', () => {
    const real = path.join(dir, 'real');
    mkdirSync(real);
    mkdirSync(path.join(dir, 'wtA'));
    symlinkSync(real, path.join(dir, 'wtA', 'node_modules'));
    mkdirSync(path.join(dir, 'wtB', 'node_modules'), { recursive: true });
    expect(classifyCommand('rm -rf node_modules/*', { cwd: path.join(dir, 'wtA') })).toBe('delete-outside-project');
    expect(classifyCommand('rm -rf node_modules/*', { cwd: path.join(dir, 'wtB') })).toBe('run-command');
    expect(classifyCommand('rm -rf node_modules/*')).toBe('run-command');
  });

  it('mapCliToolRequest 透传 cwd 给分类器（CLI 桥同款防护）', () => {
    const wt = path.join(dir, 'wtC');
    mkdirSync(wt);
    const real = path.join(dir, 'realC');
    mkdirSync(real);
    symlinkSync(real, path.join(wt, 'node_modules'));
    const mapped = mapCliToolRequest({
      toolName: 'Bash', input: { command: 'rm -rf node_modules/.cache' }, cwd: wt,
    });
    expect(mapped.action).toBe('delete-outside-project');
  });
});
