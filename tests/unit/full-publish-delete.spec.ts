/**
 * 整改批次 1：全量发布（no-approval 完全访问）对删除/重命名文件的正确处理。
 * 修复前：git diff --name-only 不分状态，删除文件按 update 发→发布管线源缺失记冲突→整批阻塞+无意义裁决。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, mkdir } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb, createNovelCompany } from '../integration/setup';
import { createProject } from '../../src/server/domain/project';
import { createTask, listTasks } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { clockIn } from '../../src/server/domain/workbench';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import {
  ensureGitRepo, createWorktree, commitAll,
  listTaskBranchChangeStatus, listTaskBranchChanges, ensureTaskStagingWorktree,
} from '../../src/server/worktree/manager';

let tmp: string;
let db: DB;

function git(dir: string, args: string[]): string {
  return execSync(['git', ...args].join(' '), { cwd: dir, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'muster-fpd-'));
  process.env.MUSTER_HOME = path.join(tmp, 'muster-home');
  db = makeTestDb().db;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
});

describe('listTaskBranchChangeStatus（状态化分类）', () => {
  it('D/A/M/R 各就各位，重命名拆删旧+增新', () => {
    const root = path.join(tmp, 'repo');
    mkdirSync(root, { recursive: true });
    ensureGitRepo(root);
    for (const f of ['keep.txt', 'drop.txt', 'edit.txt', 'old-name.txt']) writeFileSync(path.join(root, f), 'v1');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'base']);
    const wt = createWorktree(root, 'prj_1', 'tk_cls');
    writeFileSync(path.join(wt.path, 'add-new.txt'), 'new');
    rmSync(path.join(wt.path, 'drop.txt'));
    writeFileSync(path.join(wt.path, 'edit.txt'), 'v2');
    execSync(`mv old-name.txt new-name.txt`, { cwd: wt.path });
    commitAll(wt.path, 'changes');

    const changes = listTaskBranchChangeStatus(root, wt);
    const byPath = new Map(changes.map((c) => [c.path, c.status]));
    expect(byPath.get('drop.txt')).toBe('D');
    expect(byPath.get('add-new.txt')).toBe('A');
    expect(byPath.get('edit.txt')).toBe('M');
    expect(byPath.get('old-name.txt')).toBe('D');
    expect(byPath.get('new-name.txt')).toBe('A');
  });

  it('工作区未提交重命名拆删旧+增新（旧路径删除不再丢失）；中文路径不八进制转义', () => {
    const root = path.join(tmp, 'repo-porc');
    mkdirSync(root, { recursive: true });
    ensureGitRepo(root);
    for (const f of ['keep.txt', 'old-name.txt']) writeFileSync(path.join(root, f), 'v1');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'base']);
    const wt = createWorktree(root, 'prj_2', 'tk_porc');
    git(wt.path, ['mv', 'old-name.txt', 'new-name.txt']); // 已暂存重命名 → porcelain "R  old -> new"
    writeFileSync(path.join(wt.path, '中文文档.md'), '内容'); // 未跟踪中文路径（默认 core.quotePath 会转义成 "\344..."）

    const changes = listTaskBranchChangeStatus(root, wt);
    const byPath = new Map(changes.map((c) => [c.path, c.status]));
    expect(byPath.get('old-name.txt')).toBe('D'); // 修复前：旧路径丢失
    expect(byPath.get('new-name.txt')).toBe('A'); // 修复前：被错标 M
    expect(byPath.get('中文文档.md')).toBe('A'); // 修复前：路径带引号八进制转义

    // 发布守护清单（listTaskBranchChanges）同口径：重命名两个路径都在未提交清单里
    const guard = listTaskBranchChanges(root, wt);
    expect(guard.uncommitted).toContain('old-name.txt');
    expect(guard.uncommitted).toContain('new-name.txt');
    expect(guard.uncommitted).toContain('中文文档.md');
  });
});

describe('引擎全量发布：删除文件走 operation:delete', () => {
  it('no-approval 任务删除文件 → 发布后集成区文件消失、无冲突、无裁决任务', async () => {
    const r = createNovelCompany(db, { name: 'co' });
    clockIn(db);
    const rootDir = path.join(tmp, 'repo2');
    mkdirSync(rootDir, { recursive: true });
    const project = createProject(db, {
      companyId: r.company.id, name: 'p', rootDir,
      firstAgentId: r.agents.lead.id, initialState: 'active',
    });
    ensureGitRepo(rootDir);
    writeFileSync(path.join(rootDir, 'drop-me.txt'), '旧文件');
    writeFileSync(path.join(rootDir, 'keep.txt'), '保留');
    commitAll(rootDir, 'baseline');

    const thread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    createTask(db, {
      projectId: project.id,
      assigneeAgentId: r.agents.writer.id,
      title: '清理旧文件',
      inputProtocol: { mode: 'no-approval' },
    });

    const fake = new FakeExecutor().script([
      {
        deleteFiles: ['drop-me.txt'],
        result: { outcome: 'completed', summary: '已删除旧文件', outboundTasks: [], artifacts: [] },
      },
    ]);
    const engine = new TaskEngine(db, fake);
    const ran = await engine.pumpThread(thread.id);
    expect(ran).toBe(true);

    const t = listTasks(db, project.id).find((x) => x.title === '清理旧文件')!;
    expect(t.state).toBe('completed'); // 未被发布冲突阻塞
    const staging = ensureTaskStagingWorktree(rootDir, project.id, t.projectTaskId);
    expect(existsSync(path.join(staging.path, 'drop-me.txt'))).toBe(false); // 真删除
    expect(existsSync(path.join(staging.path, 'keep.txt'))).toBe(true);
    // 无裁决任务、无冲突事件
    expect(listTasks(db, project.id).some((x) => x.title.includes('裁决'))).toBe(false);
  });
});
