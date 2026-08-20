/**
 * Workspace 治理批次2：软件回收站（两段式删除）。
 * 覆盖用户定案的风险对策：
 * - 入站前置校验（防 git worktree 悬空）：active 拒 / 进行中任务拒 / 未合并集成区拒
 * - 绑定自动化自动暂停 + 恢复时提示重开
 * - 恢复撞名 → 同一日期后缀规则换新目录
 * - 真删确认语义：单个=手打原目录名；批量=手打「删除N项」一次
 * - 真删=移入系统废纸篓（MUSTER_TRASH_DIR 注入测试目录），非 rm；删库同 removeProject
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { makeTestDb, type TestDb } from './setup';
import { ensureWorkbench } from '../../src/server/domain/workbench';
import { createProject, getProject, updateProject, ensureStandaloneProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { createTask } from '../../src/server/domain/task';
import { ensureGitRepo, ensureTaskStagingWorktree } from '../../src/server/worktree/manager';
import { defaultWorkspaceRoot } from '../../src/server/domain/workspace-layout';
import {
  listTrash,
  precheckTrashProject,
  purgeFromTrash,
  restoreProject,
  trashProject,
} from '../../src/server/domain/project-trash';

let tdb: TestDb;
let sysTrash: string;

beforeEach(() => {
  tdb = makeTestDb();
  ensureWorkbench(tdb.db);
  // 真删目标注入测试目录（生产=macOS ~/.Trash；测试绝不碰真实废纸篓）
  sysTrash = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'muster-systrash-'));
  process.env.MUSTER_TRASH_DIR = sysTrash;
});

afterEach(() => {
  delete process.env.MUSTER_TRASH_DIR;
  fs.rmSync(sysTrash, { recursive: true, force: true });
  tdb.close();
});

function wsRoot(): string {
  return defaultWorkspaceRoot();
}

function makePausedProjectWithDir(name: string) {
  const p = createProject(tdb.db, { name, initialState: 'paused' });
  ensureGitRepo(p.rootDir);
  fs.writeFileSync(path.join(p.rootDir, 'note.txt'), '用户数据');
  return p;
}

describe('回收站：入站前置校验', () => {
  it('active 项目拒绝，人话提示先暂停', () => {
    const p = createProject(tdb.db, { name: '开工中', initialState: 'active' });
    const blockers = precheckTrashProject(tdb.db, getProject(tdb.db, p.id));
    expect(blockers.some((b) => b.includes('开工状态'))).toBe(true);
    expect(() => trashProject(tdb.db, p.id)).toThrowError(/开工状态/);
  });

  it('进行中任务拒绝（防丢草稿）', () => {
    const p = makePausedProjectWithDir('有活');
    createTask(tdb.db, { projectId: p.id, title: '进行中' }); // 默认 queued
    expect(() => trashProject(tdb.db, p.id)).toThrowError(/进行中的任务/);
  });

  it('未合并任务集成区拒绝（防 pt-staging 悬空）', () => {
    const p = makePausedProjectWithDir('有集成');
    const pt = createProjectTask(tdb.db, { projectId: p.id, title: '载体' });
    const staging = ensureTaskStagingWorktree(p.rootDir, p.id, pt.id);
    fs.writeFileSync(path.join(staging.path, 'draft.txt'), '集成区未合并内容');
    execSync('git add -A && git commit -q -m wip', { cwd: staging.path });
    expect(() => trashProject(tdb.db, p.id)).toThrowError(/集成区尚未合并/);
  });

  it('基础设施项目不可入站', () => {
    const { project } = ensureStandaloneProject(tdb.db);
    expect(() => trashProject(tdb.db, project.id)).toThrowError(/基础设施/);
  });
});

describe('回收站：移入/清单/恢复', () => {
  it('移入：目录搬 .trash/ 记账 + 列表隐藏 + 幂等', () => {
    const p = makePausedProjectWithDir('画册');
    const original = p.rootDir;
    const { trashDir } = trashProject(tdb.db, p.id);
    expect(trashDir.startsWith(path.join(wsRoot(), '.trash'))).toBe(true);
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.existsSync(trashDir)).toBe(true);
    expect(fs.readFileSync(path.join(trashDir, 'note.txt'), 'utf8')).toBe('用户数据');

    const after = getProject(tdb.db, p.id);
    expect((after.settings as Record<string, unknown>).trashed).toBe(true);
    const items = listTrash(tdb.db);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('画册');
    expect(items[0].originalRootDir).toBe(original);
    expect(items[0].sizeBytes).toBeGreaterThan(0);

    // 幂等：再次移入直接返回既有记录
    expect(trashProject(tdb.db, p.id).trashDir).toBe(trashDir);
  });

  it('绑定自动化与项目定时器自动暂停；恢复后返回暂停清单提示重开（修复轮 Fix3）', () => {
    const p = makePausedProjectWithDir('自动化项目');
    tdb.db.prepare(
      `INSERT INTO automation (id, kind, config_json, schedule_kind, schedule_interval_ms, project_id, enabled, created_via, created_at, updated_at)
       VALUES ('au_1', 'github-issues', '{}', 'interval', 60000, ?, 1, 'form', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z')`,
    ).run(p.id);
    tdb.db.prepare(
      `INSERT INTO trigger (id, project_id, kind, interval_ms, schedule_kind, template_json, enabled, created_at, updated_at)
       VALUES ('trg_1', ?, 'schedule', 60000, 'interval', '{}', 1, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z')`,
    ).run(p.id);
    trashProject(tdb.db, p.id);
    expect((tdb.db.prepare('SELECT enabled FROM automation WHERE id=?').get('au_1') as { enabled: number }).enabled).toBe(0);
    expect((tdb.db.prepare('SELECT enabled FROM trigger WHERE id=?').get('trg_1') as { enabled: number }).enabled).toBe(0);

    const restored = restoreProject(tdb.db, p.id);
    expect(restored.pausedAutomationIds).toEqual(['au_1']);
    expect(restored.pausedTriggerIds).toEqual(['trg_1']);
    expect(restored.rootDir).toBe(p.rootDir);
    expect(fs.existsSync(path.join(restored.rootDir, 'note.txt'))).toBe(true);
    const after = getProject(tdb.db, p.id);
    expect((after.settings as Record<string, unknown>).trashed).toBeUndefined();
    expect(listTrash(tdb.db)).toHaveLength(0);
  });

  it('恢复撞名：原位被新项目占用 → 日期后缀新目录', () => {
    const p = makePausedProjectWithDir('画册');
    trashProject(tdb.db, p.id);
    // 真实剩余撞名场景：用户在 Finder 于原位手建了同名文件夹（createProject 显式指向
    // 既有项目目录已被交叉守卫拦下——防误指他人项目）
    fs.mkdirSync(p.rootDir, { recursive: true });
    const restored = restoreProject(tdb.db, p.id);
    expect(restored.rootDir).not.toBe(p.rootDir);
    expect(path.basename(restored.rootDir)).toMatch(/^画册-\d{8}/);
    expect(fs.readFileSync(path.join(restored.rootDir, 'note.txt'), 'utf8')).toBe('用户数据');
  });

  it('ghost 项目（目录从未落盘）可入站：恢复只动库', () => {
    const p = createProject(tdb.db, { name: '幽灵', initialState: 'paused' });
    const { trashDir } = trashProject(tdb.db, p.id);
    expect(trashDir).toBe('');
    const restored = restoreProject(tdb.db, p.id);
    expect(restored.rootDir).toBe(p.rootDir);
  });
});

describe('回收站：真删（→系统废纸篓+删库）', () => {
  it('单个：确认文字=原目录名；错误拒绝；正确则目录进系统废纸篓+库删净', () => {
    const p = makePausedProjectWithDir('机密项目');
    // 修复轮 Fix2：inspector_alert 是唯一无 CASCADE 的 project 外键——先落一条告警，
    // 真删必须能清掉它（否则目录已进废纸篓而库删失败=永久卡死）
    tdb.db.prepare(
      `INSERT INTO inspector_alert (id, project_id, kind, message, severity, created_at)
       VALUES ('ia_1', ?, 'stuck', '测试告警', 'high', '2026-08-20T00:00:00Z')`,
    ).run(p.id);
    const original = p.rootDir;
    trashProject(tdb.db, p.id);
    // 错误确认
    expect(() => purgeFromTrash(tdb.db, [p.id], '随便打')).toThrowError(/机密项目/);
    // 正确确认
    const result = purgeFromTrash(tdb.db, [p.id], '机密项目');
    expect(result.purged).toBe(1);
    const moved = fs.readdirSync(sysTrash);
    expect(moved).toHaveLength(1);
    expect(moved[0].endsWith('机密项目')).toBe(true);
    expect(fs.readFileSync(path.join(sysTrash, moved[0], 'note.txt'), 'utf8')).toBe('用户数据');
    // 库删净（project/trash 行/任务级联）
    expect(tdb.db.prepare('SELECT COUNT(*) AS n FROM project WHERE id=?').get(p.id)).toEqual({ n: 0 });
    expect(tdb.db.prepare('SELECT COUNT(*) AS n FROM project_trash').get()).toEqual({ n: 0 });
    expect(fs.existsSync(original)).toBe(false);
  });

  it('批量：确认文字=「删除N项」一次；错一个不在站的直接失败', () => {
    const a = makePausedProjectWithDir('甲项目');
    const b = makePausedProjectWithDir('乙项目');
    trashProject(tdb.db, a.id, { batchId: 'batch_1' });
    trashProject(tdb.db, b.id, { batchId: 'batch_1' });
    expect(() => purgeFromTrash(tdb.db, [a.id, b.id], '删除2项 ')).toThrowError(/删除2项/);
    const result = purgeFromTrash(tdb.db, [a.id, b.id], '删除2项');
    expect(result.purged).toBe(2);
    expect(fs.readdirSync(sysTrash)).toHaveLength(2);
    expect(listTrash(tdb.db)).toHaveLength(0);
    // 不在回收站的 id → 拒绝整个操作
    const c = makePausedProjectWithDir('丙项目');
    expect(() => purgeFromTrash(tdb.db, [c.id], '丙项目')).toThrowError(/不在回收站/);
  });
});
