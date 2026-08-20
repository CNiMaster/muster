/**
 * Workspace 治理批次3：项目多目录绑定。
 * - 绑定校验：绝对路径/存在/重复拒/与任何项目目录（含本项目主目录）交叉拒/基础设施项目拒
 * - 解绑只断关联不动盘（铁律）
 * - 锚点：仅 git 仓库可设；设后 resolveTaskRepoRoot 走锚点、worktree 从锚点仓库切出；复位回主目录
 * - "从现有文件夹创建项目"：createProject 显式 rootDir → 记 external 行（幂等）
 * - 绑定即授权：attachedPaths 并入项目 scope allowedRoots 数据源
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { makeTestDb, type TestDb } from './setup';
import { ensureWorkbench } from '../../src/server/domain/workbench';
import { createProject, ensureStandaloneProject, getProject } from '../../src/server/domain/project';
import { resolveTaskRepoRoot } from '../../src/server/domain/task-repo';
import { createWorktree, ensureGitRepo, removeWorktree } from '../../src/server/worktree/manager';
import {
  attachProjectDir,
  attachedPaths,
  detachProjectDir,
  isGitRepo,
  listProjectDirs,
  resetProjectAnchor,
  setProjectAnchor,
} from '../../src/server/domain/project-dirs';

let tdb: TestDb;
let sandbox: string;

beforeEach(() => {
  tdb = makeTestDb();
  ensureWorkbench(tdb.db);
  sandbox = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'muster-dirs-'));
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  tdb.close();
});

function mkdir(name: string): string {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function gitRepo(name: string): string {
  const dir = mkdir(name);
  execSync('git init -q && git config user.email t@t && git config user.name t && echo hi > f.txt && git add -A && git commit -q -m init', { cwd: dir });
  return dir;
}

describe('绑定校验', () => {
  it('相对路径/不存在/非目录拒绝', () => {
    const p = createProject(tdb.db, { name: '甲' });
    expect(() => attachProjectDir(tdb.db, p.id, { path: 'relative/dir' })).toThrowError(/绝对路径/);
    expect(() => attachProjectDir(tdb.db, p.id, { path: path.join(sandbox, 'nope') })).toThrowError(/不存在/);
    fs.writeFileSync(path.join(sandbox, 'afile'), 'x');
    expect(() => attachProjectDir(tdb.db, p.id, { path: path.join(sandbox, 'afile') })).toThrowError(/不是文件夹/);
  });

  it('重复绑定与目录交叉拒绝（跨项目 + 本项目主目录）', () => {
    const a = createProject(tdb.db, { name: '甲' });
    const b = createProject(tdb.db, { name: '乙' });
    const dir = mkdir('素材库');
    attachProjectDir(tdb.db, a.id, { path: dir, label: '素材' });
    // 同项目重复
    expect(() => attachProjectDir(tdb.db, a.id, { path: dir })).toThrowError(/已绑定/);
    // 跨项目同路径/父子
    expect(() => attachProjectDir(tdb.db, b.id, { path: dir })).toThrowError(/交叉/);
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    expect(() => attachProjectDir(tdb.db, b.id, { path: path.join(dir, 'sub') })).toThrowError(/交叉/);
    // 本项目主目录的父层（projects/ 已随绑定前的主目录落盘而存在）
    ensureGitRepo(a.rootDir);
    expect(() => attachProjectDir(tdb.db, a.id, { path: path.dirname(a.rootDir) })).toThrowError(/交叉/);
  });

  it('基础设施项目拒绝绑定', () => {
    const { project } = ensureStandaloneProject(tdb.db);
    expect(() => attachProjectDir(tdb.db, project.id, { path: mkdir('whatever') })).toThrowError(/基础设施/);
  });

  it('绑定目录永不写 marker / 不 git init（铁律：不动用户数据）', () => {
    const p = createProject(tdb.db, { name: '甲' });
    const dir = mkdir('普通文件夹');
    attachProjectDir(tdb.db, p.id, { path: dir });
    expect(fs.existsSync(path.join(dir, '.muster'))).toBe(false);
    expect(isGitRepo(dir)).toBe(false);
  });
});

describe('清单与解绑', () => {
  it('listProjectDirs：主目录合成行（system/external 角色判定）+ 绑定行；解绑只删行不动盘', () => {
    const external = gitRepo('外部仓库');
    const p = createProject(tdb.db, { name: '代码项目', rootDir: external });
    const dirs = listProjectDirs(tdb.db, p.id);
    expect(dirs[0].id).toBe(`main:${p.id}`);
    expect(dirs[0].role).toBe('external'); // 创建时指定（在 workspace 外）
    expect(dirs[0].isAnchor).toBe(true);

    const sys = createProject(tdb.db, { name: '系统目录项目' });
    expect(listProjectDirs(tdb.db, sys.id)[0].role).toBe('system');

    const dir = mkdir('附加');
    const attached = attachProjectDir(tdb.db, sys.id, { path: dir, label: '参考' });
    expect(attachedPaths(tdb.db, sys.id)).toEqual([dir]);
    fs.writeFileSync(path.join(dir, 'user.txt'), 'keep');
    const { detached } = detachProjectDir(tdb.db, attached.id);
    expect(detached).toBe(true);
    expect(attachedPaths(tdb.db, sys.id)).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'user.txt'), 'utf8')).toBe('keep');
    expect(() => detachProjectDir(tdb.db, attached.id)).toThrowError(/不存在/);
  });

  it('createProject 显式 rootDir 记 external 行（幂等）', () => {
    const external = gitRepo('外部主目录');
    const p = createProject(tdb.db, { name: '从文件夹建', rootDir: external });
    const rows = tdb.db.prepare("SELECT COUNT(*) AS n FROM project_dir WHERE project_id=? AND role='external'").get(p.id) as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('锚点（git 仓库 → 任务 worktree 从锚点切出）', () => {
  it('非 git 拒绝；git 设锚后 resolveTaskRepoRoot=锚点且可开 worktree；复位回主目录', () => {
    const p = createProject(tdb.db, { name: '甲' });
    const plain = mkdir('非git');
    const attachedPlain = attachProjectDir(tdb.db, p.id, { path: plain });
    expect(() => setProjectAnchor(tdb.db, attachedPlain.id)).toThrowError(/git 仓库/);

    const repo = gitRepo('锚点仓库');
    const attachedRepo = attachProjectDir(tdb.db, p.id, { path: repo, label: '代码' });
    const anchored = setProjectAnchor(tdb.db, attachedRepo.id);
    expect(anchored.isAnchor).toBe(true);
    expect(listProjectDirs(tdb.db, p.id)[0].isAnchor).toBe(false); // 主目录不再是锚点

    // 任务仓库根=锚点；从锚点开 worktree（分支落锚点仓库）
    expect(resolveTaskRepoRoot(tdb.db, getProject(tdb.db, p.id), null)).toBe(repo);
    const wt = createWorktree(resolveTaskRepoRoot(tdb.db, getProject(tdb.db, p.id), null), p.id, 'tk_anchor_1');
    const branches = execSync('git branch --list "muster/*"', { cwd: repo, encoding: 'utf8' });
    expect(branches).toContain(wt.branch);
    fs.writeFileSync(path.join(wt.path, 'w.txt'), 'work');
    removeWorktree(repo, wt);

    // 复位：主目录回锚
    resetProjectAnchor(tdb.db, p.id);
    expect(resolveTaskRepoRoot(tdb.db, getProject(tdb.db, p.id), null)).toBe(p.rootDir);
  });
});
