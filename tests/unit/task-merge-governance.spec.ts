/**
 * 任务级集成区治理（批次 G·修复轮）：
 * - ensureTaskStagingWorktree/taskStageStatus：分支 muster/<pid>/pt-<ptid>、幂等、领先计数
 * - promoteTaskStaging：premium approve→合并回主干+记录+播报；concern→跳过留痕；LLM 失败→skipped 不阻塞
 * - 合并开关：settings_json.mergeMode 默认 manual / setProjectMergeMode 切 auto
 * - promote 冲突返回清单不自动吞；strategy 选边可解（批次 I 消费）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject, getProjectMergeMode, setProjectMergeMode } from '../../src/server/domain/project';
import * as llmCallModule from '../../src/server/domain/llm-call';
import {
  ensureTaskStagingWorktree,
  taskStageStatus,
  promoteTaskStagingMerge,
  taskStagingBranch,
} from '../../src/server/worktree/manager';
import {
  listPendingTaskMerges,
  promoteTaskStaging,
} from '../../src/server/domain/staging';

let root: string;
let db: DB;

function git(dir: string, args: string[]): string {
  return execSync([String.raw`git`, ...args.map((a) => JSON.stringify(a))].join(String.raw` `), { cwd: dir, encoding: String.raw`utf-8` }).trim();
}

function projectRoot(projectId: string): string {
  const row = db.prepare('SELECT root_dir FROM project WHERE id=?').get(projectId) as { root_dir: string };
  return row.root_dir;
}

/** 造一个带任务集成分支领先 2 提交的项目夹具。 */
function fixtureProject(tag = 'tmg'): { projectId: string; projectTaskId: string; stagingPath: string } {
  const workbench = restoreWorkbench(db, { id: `wb_${tag}`, name: '工作台' });
  const project = createProject(db, { companyId: workbench.id, name: '项目', initialState: 'active' });
  const rootDir = project.rootDir;
  mkdirSync(rootDir, { recursive: true });
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: rootDir });
  writeFileSync(path.join(rootDir, 'base.txt'), 'base');
  git(rootDir, ['add', '-A']);
  git(rootDir, ['commit', '-m', 'base']);
  const ptId = `pt_${tag}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    "INSERT INTO project_task (id, project_id, seq, title, state, created_at, updated_at) VALUES (?,?,1,'集成任务','active',?,?)",
  ).run(ptId, project.id, new Date().toISOString(), new Date().toISOString());
  const staging = ensureTaskStagingWorktree(rootDir, project.id, ptId);
  writeFileSync(path.join(staging.path, 'r1.txt'), 'round1');
  git(staging.path, ['add', '-A']);
  git(staging.path, ['commit', '-m', 'r1']);
  writeFileSync(path.join(staging.path, 'r2.txt'), 'round2');
  git(staging.path, ['add', '-A']);
  git(staging.path, ['commit', '-m', 'r2']);
  return { projectId: project.id, projectTaskId: ptId, stagingPath: staging.path };
}

beforeEach(() => {
  vi.restoreAllMocks();
  root = mkdtempSync(path.join(tmpdir(), 'muster-taskmerge-'));
  process.env.MUSTER_HOME = path.join(root, '.muster-home');
  db = makeTestDb().db;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
});

describe('任务级集成区（批次 G·修复轮）', () => {
  it('ensureTaskStagingWorktree 幂等 + taskStageStatus 领先计数', () => {
    const f = fixtureProject();
    const rootDir = projectRoot(f.projectId);
    const again = ensureTaskStagingWorktree(rootDir, f.projectId, f.projectTaskId);
    expect(again.path).toBe(f.stagingPath);
    const status = taskStageStatus(rootDir, f.projectId, f.projectTaskId);
    expect(status.exists).toBe(true);
    expect(status.aheadCommits).toBe(2);
    expect(taskStagingBranch(f.projectId, f.projectTaskId)).toBe(`muster/${f.projectId}/pt-${f.projectTaskId}`);
  });

  it('合并开关：默认 manual；setProjectMergeMode 写 settings_json', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_tmg_mode', name: '工作台' });
    const project = createProject(db, { companyId: workbench.id, name: '项目', initialState: 'active' });
    expect(getProjectMergeMode(db, project.id)).toBe('manual');
    setProjectMergeMode(db, project.id, 'auto');
    expect(getProjectMergeMode(db, project.id)).toBe('auto');
  });

  it('promoteTaskStaging：premium approve → 合并回主干 + 审计记录 + 项目群播报', async () => {
    const f = fixtureProject();
    const rootDir = projectRoot(f.projectId);
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValueOnce({
      content: JSON.stringify({ verdict: 'approve', reason: '变更安全', summary: '合入两轮成果：r1/r2' }),
    } as never);
    const result = await promoteTaskStaging(db, f.projectId, f.projectTaskId, { actor: 'ui' });
    expect(result.promoted).toBe(true);
    expect(result.summary).toContain('两轮成果');
    expect(existsSync(path.join(rootDir, 'r1.txt'))).toBe(true);
    expect(existsSync(path.join(rootDir, 'r2.txt'))).toBe(true);
    expect(taskStageStatus(rootDir, f.projectId, f.projectTaskId).aheadCommits).toBe(0);
    const rec = db.prepare('SELECT * FROM task_merge_record WHERE project_task_id=?').all(f.projectTaskId) as Array<{ status: string; summary: string }>;
    expect(rec).toHaveLength(1);
    expect(rec[0]!.status).toBe('promoted');
    const broadcast = db.prepare("SELECT content FROM conversation_message WHERE scope_id=? AND author='system'").all(f.projectId) as Array<{ content: string }>;
    expect(broadcast.some((b) => b.content.includes('任务合并回主干'))).toBe(true);
  });

  it('promoteTaskStaging：concern → 本轮跳过留痕，主干不被污染', async () => {
    const f = fixtureProject();
    const rootDir = projectRoot(f.projectId);
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValueOnce({
      content: JSON.stringify({ verdict: 'concern', reason: '疑似误删配置文件', summary: '待人工检查' }),
    } as never);
    const result = await promoteTaskStaging(db, f.projectId, f.projectTaskId, { actor: 'ui' });
    expect(result.promoted).toBe(false);
    expect(result.reviewVerdict).toBe('concern');
    expect(existsSync(path.join(rootDir, 'r1.txt'))).toBe(false);
    const rec = db.prepare('SELECT status FROM task_merge_record WHERE project_task_id=?').get(f.projectTaskId) as { status: string };
    expect(rec.status).toBe('concern');
  });

  it('promoteTaskStaging：LLM 失败 → skipped 不阻塞（下轮可重试）', async () => {
    const f = fixtureProject();
    vi.spyOn(llmCallModule, 'callLlm').mockRejectedValueOnce(new Error('net down') as never);
    const result = await promoteTaskStaging(db, f.projectId, f.projectTaskId, { actor: 'watchdog' });
    expect(result.promoted).toBe(false);
    expect(result.reviewVerdict).toBe('skipped');
    const rec = db.prepare('SELECT status FROM task_merge_record WHERE project_task_id=?').get(f.projectTaskId) as { status: string };
    expect(rec.status).toBe('skipped');
  });

  it('listPendingTaskMerges：领先任务入看板，含在飞子任务计数', () => {
    const f = fixtureProject();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO task (id, project_id, project_task_id, seq, root_task_id, title, input_protocol_json, context_refs_json, output_protocol_json, priority, state, clarification_rounds, is_discussion, is_suggestion, budget_json, created_at, updated_at, swarm_depth) VALUES (?,?,?,?,?,'在飞','{}','{}','{}',5,'running',0,0,0,'{}',?,?,0)",
    ).run('tk_inflight', f.projectId, f.projectTaskId, 1, 'tk_inflight', now, now);
    const items = listPendingTaskMerges(db, f.projectId);
    expect(items).toHaveLength(1);
    expect(items[0]!.projectTaskId).toBe(f.projectTaskId);
    expect(items[0]!.aheadCommits).toBe(2);
    expect(items[0]!.pendingRuntimeTasks).toBe(1);
    expect(items[0]!.mergeMode).toBe('manual');
  });

  it('promote 冲突 → 返回清单不自动吞；strategy 选边可解（批次 I 消费）', () => {
    const f = fixtureProject();
    const rootDir = projectRoot(f.projectId);
    writeFileSync(path.join(rootDir, 'r1.txt'), 'main-side');
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-m', 'main edit']);
    const conflicted = promoteTaskStagingMerge(rootDir, f.projectId, f.projectTaskId);
    expect(conflicted.promoted).toBe(false);
    expect(conflicted.conflicts).toContain('r1.txt');
    const resolved = promoteTaskStagingMerge(rootDir, f.projectId, f.projectTaskId, { strategy: 'theirs' });
    expect(resolved.promoted).toBe(true);
    expect(readFileSync(path.join(rootDir, 'r1.txt'), 'utf8')).toBe('round1');
  });
});
