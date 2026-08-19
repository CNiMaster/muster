/**
 * 整改批次 2：promote 前确定性检查。
 * - 解析：显式配置优先；未配置探测 package.json scripts.typecheck；都无 → 空
 * - promoteTaskStaging 集成：检查失败 → check_failed 记录+播报+主干不动；通过 → 正常合并；无检查 → 直接合并
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject, updateProject } from '../../src/server/domain/project';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { getPreMergeChecks, runPreMergeChecks } from '../../src/server/domain/pre-merge-checks';
import { ensureTaskStagingWorktree, ensureGitRepo, commitAll } from '../../src/server/worktree/manager';
import { promoteTaskStaging } from '../../src/server/domain/staging';

let tmp: string;
let db: DB;

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout).trim();
}

function fixtureProject(tag: string, opts: { settings?: Record<string, unknown>; pkgScripts?: Record<string, string> } = {}): { projectId: string; projectTaskId: string } {
  const workbench = restoreWorkbench(db, { id: `wb_pmc_${tag}`, name: '工作台' });
  const project = createProject(db, { companyId: workbench.id, name: '项目', initialState: 'active', ...({} as never) });
  mkdirSync(project.rootDir, { recursive: true });
  if (opts.settings) updateProject(db, project.id, { settings: { ...(opts.settings) } });
  if (opts.pkgScripts) writeFileSync(path.join(project.rootDir, 'package.json'), JSON.stringify({ name: 'p', scripts: opts.pkgScripts }));
  ensureGitRepo(project.rootDir);
  writeFileSync(path.join(project.rootDir, 'base.txt'), 'base');
  git(project.rootDir, ['add', '-A']);
  git(project.rootDir, ['commit', '-m', 'base']);
  const ptId = `pt_pmc${Math.random().toString(36).slice(2, 8)}`;
  db.prepare("INSERT INTO project_task (id, project_id, seq, title, state, created_at, updated_at) VALUES (?,?,1,'集成','active',?,?)")
    .run(ptId, project.id, new Date().toISOString(), new Date().toISOString());
  const staging = ensureTaskStagingWorktree(project.rootDir, project.id, ptId);
  writeFileSync(path.join(staging.path, 'out.txt'), 'result');
  git(staging.path, ['add', '-A']);
  git(staging.path, ['commit', '-m', 'wip']);
  return { projectId: project.id, projectTaskId: ptId };
}

function rootOf(projectId: string): string {
  return (db.prepare('SELECT root_dir FROM project WHERE id=?').get(projectId) as { root_dir: string }).root_dir;
}

function mockReviewApprove(): void {
  vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue({
    content: JSON.stringify({ verdict: 'approve', reason: '安全', summary: '摘要' }),
  } as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
  tmp = mkdtempSync(path.join(tmpdir(), 'muster-pmc-'));
  process.env.MUSTER_HOME = path.join(tmp, 'muster-home');
  db = makeTestDb().db;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
});

describe('检查命令解析', () => {
  it('显式配置优先；未配置探测 typecheck script；都无则空', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_pmc_r', name: '工作台' });
    const a = createProject(db, { companyId: workbench.id, name: 'A', initialState: 'active' });
    mkdirSync(a.rootDir, { recursive: true });
    // 都无 → 空
    expect(getPreMergeChecks(db, a.id)).toEqual([]);
    // 探测命中
    writeFileSync(path.join(a.rootDir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc -b' } }));
    expect(getPreMergeChecks(db, a.id)).toEqual([{ name: 'typecheck（自动探测）', command: 'npm run typecheck' }]);
    // 显式配置覆盖探测
    updateProject(db, a.id, { settings: { preMergeChecks: [{ name: '自定义', command: 'make check' }] } });
    expect(getPreMergeChecks(db, a.id)).toEqual([{ name: '自定义', command: 'make check' }]);
  });
});

describe('runPreMergeChecks（单命令执行）', () => {
  it('失败带输出尾部；成功 ok；node_modules 软链用完即删', async () => {
    const dir = mkdtempSync(path.join(tmp, 'run-'));
    mkdirSync(path.join(dir, 'proj', 'node_modules'), { recursive: true });
    writeFileSync(path.join(dir, 'proj', 'node_modules', '.keep'), '');
    mkdirSync(path.join(dir, 'staging'), { recursive: true });

    const bad = await runPreMergeChecks(path.join(dir, 'proj'), path.join(dir, 'staging'), [
      { name: '检查', command: 'node -e "console.error(123); process.exit(1)"' },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.failed!.outputTail).toContain('123');
    expect(existsSync(path.join(dir, 'staging', 'node_modules'))).toBe(false); // 软链已清理

    const good = await runPreMergeChecks(path.join(dir, 'proj'), path.join(dir, 'staging'), [
      { name: '检查', command: 'node -e 0' },
    ]);
    expect(good.ok).toBe(true);
  });
});

describe('promoteTaskStaging 接线', () => {
  it('检查失败 → check_failed 记录+播报，主干不被合并；通过 → 正常合并', async () => {
    const f = fixtureProject('fail', { settings: { preMergeChecks: [{ name: '测试检查', command: 'node -e "process.exit(3)"' }] } });
    mockReviewApprove();
    const blocked = await promoteTaskStaging(db, f.projectId, f.projectTaskId, { actor: 'ui' });
    expect(blocked.promoted).toBe(false);
    expect(blocked.message).toContain('测试检查');
    expect(existsSync(path.join(rootOf(f.projectId), 'out.txt'))).toBe(false);
    const rec = db.prepare('SELECT status FROM task_merge_record WHERE project_task_id=?').get(f.projectTaskId) as { status: string };
    expect(rec.status).toBe('check_failed');
    const broadcast = db.prepare("SELECT content FROM conversation_message WHERE scope_id=? AND author='system'").all(f.projectId) as Array<{ content: string }>;
    expect(broadcast.some((b) => b.content.includes('合并前检查未通过'))).toBe(true);

    // 通过 → 正常合并进主干
    const f2 = fixtureProject('pass', { settings: { preMergeChecks: [{ name: '检查', command: 'node -e 0' }] } });
    mockReviewApprove();
    const ok = await promoteTaskStaging(db, f2.projectId, f2.projectTaskId, { actor: 'ui' });
    expect(ok.promoted).toBe(true);
    expect(existsSync(path.join(rootOf(f2.projectId), 'out.txt'))).toBe(true);
  });

  it('无配置无 package.json → 直接走语义审查合并（非 JS 项目不阻塞）', async () => {
    const f = fixtureProject('nose');
    mockReviewApprove();
    const r = await promoteTaskStaging(db, f.projectId, f.projectTaskId, { actor: 'ui' });
    expect(r.promoted).toBe(true);
  });

  it('探测命中：package.json typecheck script 作为默认检查执行', async () => {
    const f = fixtureProject('detect', { pkgScripts: { typecheck: 'node -e 0' } });
    mockReviewApprove();
    const r = await promoteTaskStaging(db, f.projectId, f.projectTaskId, { actor: 'ui' });
    expect(r.promoted).toBe(true);
    // 反证：script 失败则阻塞
    const f2 = fixtureProject('detect2', { pkgScripts: { typecheck: 'node -e "process.exit(1)"' } });
    mockReviewApprove();
    const r2 = await promoteTaskStaging(db, f2.projectId, f2.projectTaskId, { actor: 'ui' });
    expect(r2.promoted).toBe(false);
    expect(r2.message).toContain('确定性检查');
  });
});
