/**
 * 管理工作台批1：项目移除双语义 / 目录树 / 独立任务载体 / 任务置顶与记录删除。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb, type DB } from '../../src/server/db/client';
import { ensureWorkbench } from '../../src/server/domain/workbench';
import {
  createProject,
  ensureStandaloneProject,
  listProjects,
  removeProject,
  getProject,
  updateProject,
} from '../../src/server/domain/project';
import {
  archiveProjectTask,
  createProjectTask,
  deleteProjectTaskRecord,
  listProjectTasks,
  setProjectTaskPinned,
  getProjectTask,
  restoreProjectTask,
} from '../../src/server/domain/project-task';
import { listProjectFileTree } from '../../src/server/domain/project-files';
import { createTask } from '../../src/server/domain/task';
import { createAgent } from '../../src/server/domain/agent';
import { projectsRouter, projectById } from '../../src/server/api/projects';
import { errorMiddleware } from '../../src/server/api/middleware';
import { AppError } from '../../src/shared/errors';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let tmpRoot: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  ensureWorkbench(db);
  tmpRoot = mkdtempSync('/tmp/muster-pm-'); // 必须在默认 ALLOWED_ROOTS(/tmp) 内，macOS 的 os.tmpdir() 在 /var/folders 会被拒
});

afterEach(() => {
  closeDb();
  tdb.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function proj(name: string, rootDir?: string) {
  return createProject(db, { name, rootDir, initialState: 'active' });
}

describe('移除项目（三点菜单语义）', () => {
  it('默认＝隐藏：列表不显示、记录完整保留、目录不动', () => {
    const p = proj('A', tmpRoot);
    const lead = createAgent(db, { companyId: ensureWorkbench(db).workbench.id, name: 'lead', role: 'lead' });
    createProjectTask(db, { projectId: p.id, title: 't1' });
    createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '子任务' });

    const r = removeProject(db, p.id);

    expect(r).toEqual({ removed: true, recordsDeleted: false });
    // 记录完整保留（域层全量可见；显示过滤在 API 层 view 过滤用例验证）
    expect((getProject(db, p.id).settings as Record<string, unknown>).removed).toBe(true);
    expect(listProjects(db).map((x) => x.id)).toContain(p.id);
    // 铁律：仓库目录原样
    expect(existsSync(tmpRoot)).toBe(true);
  });

  it('deleteRecords=true＝删平台记录，但绝不删仓库目录', () => {
    const p = proj('B', tmpRoot);
    const lead = createAgent(db, { companyId: ensureWorkbench(db).workbench.id, name: 'lead2', role: 'lead' });
    const pt = createProjectTask(db, { projectId: p.id, title: 't' });
    createTask(db, { projectId: p.id, projectTaskId: pt.id, assigneeAgentId: lead.id, title: '运行中' });
    writeFileSync(path.join(tmpRoot, 'user-file.txt'), '用户数据');

    const r = removeProject(db, p.id, { deleteRecords: true });

    expect(r).toEqual({ removed: true, recordsDeleted: true });
    expect(() => getProject(db, p.id)).toThrow(/not found/);
    // 级联清理：task/project_task 行消失
    expect((db.prepare('SELECT COUNT(*) c FROM task').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM project_task').get() as { c: number }).c).toBe(0);
    // 铁律：目录与用户文件原样保留
    expect(existsSync(path.join(tmpRoot, 'user-file.txt'))).toBe(true);
  });

  it('基础设施项目（独立任务）不可移除', () => {
    const { project } = ensureStandaloneProject(db);
    expect(() => removeProject(db, project.id)).toThrow(AppError);
  });
});

describe('目录树（只读 + 防逃逸）', () => {
  it('列目录树：目录在前、忽略 .git/node_modules、size 有值', () => {
    mkdirSync(path.join(tmpRoot, 'docs'));
    mkdirSync(path.join(tmpRoot, '.git'));
    writeFileSync(path.join(tmpRoot, 'README.md'), 'x');
    writeFileSync(path.join(tmpRoot, 'docs', 'a.md'), 'y');

    const p = proj('C', tmpRoot);
    const tree = listProjectFileTree(db, p.id);

    expect(tree.map((n) => n.name)).toEqual(['docs', 'README.md']);
    expect(tree[0]!.children!.map((c: { name: string }) => c.name)).toEqual(['a.md']);
    expect(tree[1]!.size).toBe(1);
  });

  it('路径逃逸被拒（../ 指向 rootDir 之外）', () => {
    const p = proj('D', tmpRoot);
    expect(() => listProjectFileTree(db, p.id, '../outside')).toThrow(/路径逃逸/);
  });

  it('depth=1 只列一层', () => {
    mkdirSync(path.join(tmpRoot, 'sub'));
    writeFileSync(path.join(tmpRoot, 'sub', 'f.txt'), 'x');
    const p = proj('E', tmpRoot);
    const tree = listProjectFileTree(db, p.id, '', 1);
    const sub = tree.find((n) => n.name === 'sub')!;
    expect(sub.children).toEqual([]);
  });
});

describe('独立任务载体', () => {
  it('幂等创建隐藏项目，任务挂载与置顶复用现有通道', () => {
    const first = ensureStandaloneProject(db);
    const second = ensureStandaloneProject(db);
    expect(second.created).toBe(false);
    expect(second.project.id).toBe(first.project.id);
    expect((first.project.settings as Record<string, unknown>).standalone).toBe(true);

    const a = createProjectTask(db, { projectId: first.project.id, title: '买咖啡' });
    const b = createProjectTask(db, { projectId: first.project.id, title: '写周报' });
    setProjectTaskPinned(db, a.id, true, first.project.id);

    const list = listProjectTasks(db, first.project.id);
    expect(list.map((t) => t.title)).toEqual(['买咖啡', '写周报']);
    expect(list[0]!.pinned).toBe(true);

    // 归档 → 删除记录（不触碰文件）
    archiveProjectTask(db, a.id, first.project.id);
    deleteProjectTaskRecord(db, a.id, first.project.id);
    expect(listProjectTasks(db, first.project.id).map((t) => t.id)).toEqual([b.id]);
  });

  it('未归档的任务不可直接删除记录', () => {
    const { project } = ensureStandaloneProject(db);
    const t = createProjectTask(db, { projectId: project.id, title: '进行中' });
    expect(() => deleteProjectTaskRecord(db, t.id, project.id)).toThrow(/仅归档/);
  });
});

describe('任务拖动排序（修订轮）', () => {
  it('reorder 后列表序即手排序；未拖过的新任务靠顶', async () => {
    const { reorderProjectTasks } = await import('../../src/server/domain/project-task');
    const p = proj('拖序', tmpRoot);
    const a = createProjectTask(db, { projectId: p.id, title: 'A' });
    const b = createProjectTask(db, { projectId: p.id, title: 'B' });
    const c = createProjectTask(db, { projectId: p.id, title: 'C' });
    // 手排：C 在最上，其次 A、B
    reorderProjectTasks(db, p.id, [c.id, a.id, b.id]);
    expect(listProjectTasks(db, p.id).map((t) => t.title)).toEqual(['C', 'A', 'B']);
    // 新建未拖过（sort_order=0）→ 排在最前
    createProjectTask(db, { projectId: p.id, title: '新任务' });
    expect(listProjectTasks(db, p.id).map((t) => t.title)).toEqual(['新任务', 'C', 'A', 'B']);
  });
});

describe('归档还原（批3）', () => {
  it('项目 archived → active 还原合法（updateProject state 出口）', () => {
    const p = proj('还原测试', tmpRoot);
    updateProject(db, p.id, { state: 'archived' });
    expect(getProject(db, p.id).state).toBe('archived');
    const restored = updateProject(db, p.id, { state: 'active' });
    expect(restored.state).toBe('active');
  });

  it('任务归档 → 还原 active、archived_at 清空；还原后不可直接删记录', async () => {
    const p = proj('任务还原', tmpRoot);
    const t = createProjectTask(db, { projectId: p.id, title: '可还原' });
    archiveProjectTask(db, t.id, p.id);
    expect(getProjectTask ?? null).toBeTruthy();
    const restored = restoreProjectTask(db, t.id, p.id);
    expect(restored.state).toBe('active');
    expect(restored.archivedAt).toBeNull();
    expect(() => deleteProjectTaskRecord(db, t.id, p.id)).toThrow(/仅归档/);
  });
});

describe('任务顶栏（git 分支面 + rename/unread + task-context）', () => {
  it('git 分支：列分支 / 图谱 / 任务 worktree 检出（创建并切换）', async () => {
    const { execSync } = await import('node:child_process');
    const { createWorktree } = await import('../../src/server/worktree/manager');
    const { listBranches, gitGraph, checkoutInTaskWorktree, taskWorktreePath, taskWorktreeBranch } = await import('../../src/server/domain/git-branches');
    const { createTask } = await import('../../src/server/domain/task');
    const { createAgent } = await import('../../src/server/domain/agent');
    execSync('git init -q', { cwd: tmpRoot });
    execSync("git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init && git branch feat-x", { cwd: tmpRoot });
    const p = proj('git 项目', tmpRoot);
    const lead = createAgent(db, { companyId: ensureWorkbench(db).workbench.id, name: 'lead', role: 'lead' });
    const pt = createProjectTask(db, { projectId: p.id, title: '分支任务' });
    const agentTask = createTask(db, { projectId: p.id, projectTaskId: pt.id, assigneeAgentId: lead.id, title: '执行' });

    // 无 worktree 时：分支可列、检出被拒（不越权动主干）
    const branches = listBranches(db, p.id);
    expect(branches.map((b) => b.name).sort()).toEqual(['feat-x', 'master', 'main'].filter((n) => branches.some((b) => b.name === n)).sort());
    expect(gitGraph(db, p.id)).toContain('init');
    expect(() => checkoutInTaskWorktree(db, pt.id, 'feat-x')).toThrow(/尚无工作区/);

    // 建 worktree 后：创建并检出新分支成功，分支实时生效
    const { ensureGitRepo } = await import('../../src/server/worktree/manager');
    ensureGitRepo(tmpRoot);
    const wt = createWorktree(tmpRoot, p.id, agentTask.id);
    const { saveTaskRuntime } = await import('../../src/server/domain/task-runtime');
    saveTaskRuntime(db, wt);
    expect(taskWorktreePath(db, pt.id)).toBe(wt.path);
    checkoutInTaskWorktree(db, pt.id, 'feat-x');
    expect(taskWorktreeBranch(db, pt.id)).toBe('feat-x');
    checkoutInTaskWorktree(db, pt.id, 'brand-new', { create: true });
    expect(taskWorktreeBranch(db, pt.id)).toBe('brand-new');
  });

  it('rename / unread / task-context（会话 ID 回退线程 id）', async () => {
    const { renameProjectTask, setProjectTaskUnread } = await import('../../src/server/domain/project-task');
    const { getTaskContext } = await import('../../src/server/domain/open-location');
    const { ensureProjectTaskThread } = await import('../../src/server/domain/project-task-thread');
    const p = proj('ctx 项目', tmpRoot);
    const pt = createProjectTask(db, { projectId: p.id, title: '原名' });
    const lead2 = createAgent(db, { companyId: ensureWorkbench(db).workbench.id, name: 'ctx-lead', role: 'lead' });
    ensureProjectTaskThread(db, { projectTaskId: pt.id, employeeId: lead2.id, executorProfileId: null });
    expect(renameProjectTask(db, pt.id, ' 新名字 ', p.id).title).toBe('新名字');
    expect(setProjectTaskUnread(db, pt.id, true, p.id).unread).toBe(true);
    const ctx = getTaskContext(db, pt.id);
    expect(ctx.projectRootDir).toBe(tmpRoot);
    expect(ctx.worktreePath).toBeNull();
    expect(ctx.sessionId).toBeTruthy();
  });
});

describe('API 层：view 过滤与 DELETE 端点', () => {
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use('/projects', projectsRouter);
    app.use('/projects/:id', projectById);
    app.use(errorMiddleware);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => { server.close(); });

  it('view=archived/removed 过滤正确；DELETE 隐藏后从 active 消失', async () => {
    const active = proj('活跃', tmpRoot);
    const archived = proj('已归档', tmpRoot);
    updateProject(db, archived.id, { state: 'archived' });

    const activeList = (await (await fetch(`${base}/projects`)).json()) as Array<{ name: string }>;
    expect(activeList.map((p) => p.name)).toContain('活跃');
    expect(activeList.map((p) => p.name)).not.toContain('已归档');

    const archivedList = (await (await fetch(`${base}/projects?view=archived`)).json()) as Array<{ name: string }>;
    expect(archivedList.map((p) => p.name)).toEqual(['已归档']);

    const del = await fetch(`${base}/projects/${active.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(del.status).toBe(200);
    const after = (await (await fetch(`${base}/projects`)).json()) as Array<{ name: string }>;
    expect(after.map((p) => p.name)).not.toContain('活跃');
    const removedList = (await (await fetch(`${base}/projects?view=removed`)).json()) as Array<{ name: string }>;
    expect(removedList.map((p) => p.name)).toContain('活跃');
  });

  it('standalone-tasks：懒建载体并列任务', async () => {
    const r = await fetch(`${base}/projects/standalone-tasks`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { projectId: string; tasks: Array<{ title: string }> };
    expect(body.projectId).toBeTruthy();
    expect(Array.isArray(body.tasks)).toBe(true);
  });
});
