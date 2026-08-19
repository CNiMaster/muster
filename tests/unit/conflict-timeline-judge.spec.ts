/**
 * 冲突时间线加权裁决（批次 I·修复轮）：
 * - buildIntentTimeline：任务/用户消息混合按**开始时间**倒序（非完成时间），晚开始=更新用户意图
 * - dispatchConflictJudgment：派裁决法庭（debate-judge），instruction 含冲突清单与时间线
 * - handleConflictJudgeCompletion：高置信 SIDE → 自动选边重发布（-X）+记录+播报；低置信 → 升级用户带时间线
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask } from '../../src/server/domain/task';
import { buildIntentTimeline } from '../../src/server/domain/conflict-timeline';
import {
  dispatchConflictJudgment,
  handleConflictJudgeCompletion,
} from '../../src/server/domain/conflict-judge';
import { ensureTaskStagingWorktree } from '../../src/server/worktree/manager';

let root: string;
let db: DB;

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout).trim();
}

function projectRoot(projectId: string): string {
  const row = db.prepare('SELECT root_dir FROM project WHERE id=?').get(projectId) as { root_dir: string };
  return row.root_dir;
}

function addPt(projectId: string, seq: number, title: string, createdAt: string): string {
  const id = `pt_ci${seq}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    "INSERT INTO project_task (id, project_id, seq, title, state, created_at, updated_at) VALUES (?,?,?,?, 'active', ?, ?)",
  ).run(id, projectId, seq, title, createdAt, createdAt);
  return id;
}

/** 造冲突现场：主干侧与任务集成区同文件不同改动（merge 必冲突）。 */
function fixtureConflict(tag: string): { projectId: string; projectTaskId: string } {
  const workbench = restoreWorkbench(db, { id: `wb_ci_${tag}`, name: '工作台' });
  const project = createProject(db, { companyId: workbench.id, name: '项目', initialState: 'active' });
  mkdirSync(project.rootDir, { recursive: true });
  git(project.rootDir, ['init', '-q']); git(project.rootDir, ['config', 'user.email', 't@t']); git(project.rootDir, ['config', 'user.name', 't']);
  writeFileSync(path.join(project.rootDir, 'doc.md'), 'base\n');
  git(project.rootDir, ['add', '-A']);
  git(project.rootDir, ['commit', '-m', 'base']);
  const ptId = addPt(project.id, 1, '冲突任务', new Date().toISOString());
  const staging = ensureTaskStagingWorktree(project.rootDir, project.id, ptId);
  writeFileSync(path.join(staging.path, 'doc.md'), 'task-side\n');
  git(staging.path, ['add', '-A']);
  git(staging.path, ['commit', '-m', 'task edit']);
  writeFileSync(path.join(project.rootDir, 'doc.md'), 'main-side\n');
  git(project.rootDir, ['add', '-A']);
  git(project.rootDir, ['commit', '-m', 'main edit']);
  return { projectId: project.id, projectTaskId: ptId };
}

function makeJudgeTask(f: { projectId: string; projectTaskId: string }, summary: string): string {
  const t = createTask(db, {
    projectId: f.projectId,
    projectTaskId: f.projectTaskId,
    title: '[裁决] 任务集成区合并冲突 #1',
    inputProtocol: {
      conflictMerge: { projectId: f.projectId, projectTaskId: f.projectTaskId, conflicts: ['doc.md'], attempt: 1 },
    },
  });
  db.prepare("UPDATE task SET state='completed', outcome='completed', summary=? WHERE id=?").run(summary, t.id);
  return t.id;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'muster-conflict-'));
  process.env.MUSTER_HOME = path.join(root, '.muster-home');
  db = makeTestDb().db;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
});

describe('冲突时间线加权裁决（批次 I·修复轮）', () => {
  it('buildIntentTimeline：任务与用户消息混合，按开始时间倒序（晚开始在前）', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_ci_tl', name: '工作台' });
    const project = createProject(db, { companyId: workbench.id, name: '项目', initialState: 'active' });
    const t0 = '2026-08-19T10:00:00.000Z';
    const t1 = '2026-08-19T12:00:00.000Z';
    const t2 = '2026-08-19T14:00:00.000Z';
    addPt(project.id, 1, '早任务', t0);
    addPt(project.id, 2, '晚任务', t2);
    db.prepare(
      "INSERT INTO conversation_message (id, scope_kind, scope_id, author, role, content, created_at) VALUES ('cm_1','project',?,'user','user','稍后开工的新指示',?)",
    ).run(project.id, t1);

    const tl = buildIntentTimeline(db, project.id, 'pt_ignored');
    expect(tl.lines[0]).toContain('晚任务');
    expect(tl.lines[1]).toContain('稍后开工的新指示');
    expect(tl.lines[2]).toContain('早任务');
    // 开始时间序而非字典序：最新意图永远第一行
    expect(tl.parties[0]!.startedAt).toBe(t2);
  });

  it('dispatchConflictJudgment：派裁决法庭任务（debate-judge 执行者 + 时间线入 instruction）', () => {
    const f = fixtureConflict('dsp');
    const judgeTaskId = dispatchConflictJudgment(db, { projectId: f.projectId, projectTaskId: f.projectTaskId, conflicts: ['doc.md'], attempt: 1 });
    const t = getTask(db, judgeTaskId);
    const judge = db.prepare('SELECT role, is_system FROM agent_definition WHERE id=?').get(t.assigneeAgentId!) as { role: string; is_system: number };
    expect(judge.role).toBe('debate-judge');
    const ip = (t.inputProtocol ?? {}) as Record<string, unknown>;
    expect(String(ip.instruction)).toContain('SIDE=ours');
    expect(String(ip.instruction)).toContain('doc.md');
    const evts = db.prepare("SELECT kind FROM task_event WHERE task_id=? AND kind='conflict_judge_dispatched'").all(judgeTaskId);
    expect(evts).toHaveLength(1);
  });

  it('高置信 SIDE=theirs → 自动选边重发布进主干 + 记录 + 播报', async () => {
    const f = fixtureConflict('hi');
    const judgeTaskId = makeJudgeTask(f, '判定完成\nSIDE=theirs\nCONFIDENCE=0.9\nRATIONALE=任务 14:02 开始较新且语义完整');
    await handleConflictJudgeCompletion(db, judgeTaskId);
    // theirs=采任务集成区版本 → 主干可见
    const rootDir = projectRoot(f.projectId);
    expect(existsSync(path.join(rootDir, 'doc.md'))).toBe(true);
    const rec = db.prepare("SELECT status, summary FROM task_merge_record WHERE project_task_id=? ORDER BY created_at DESC LIMIT 1").get(f.projectTaskId) as { status: string; summary: string };
    expect(rec.status).toBe('promoted');
    expect(rec.summary).toContain('裁决法庭选边');
    const broadcast = db.prepare("SELECT content FROM conversation_message WHERE scope_id=? AND author='system'").all(f.projectId) as Array<{ content: string }>;
    expect(broadcast.some((b) => b.content.includes('冲突裁决自动选边') && b.content.includes('14:02'))).toBe(true);
  });

  it('低置信 → 升级用户带时间线展示，主干不被改动', async () => {
    const f = fixtureConflict('lo');
    const judgeTaskId = makeJudgeTask(f, '判定完成\nSIDE=ours\nCONFIDENCE=0.2\nRATIONALE=两侧证据均不足');
    await handleConflictJudgeCompletion(db, judgeTaskId);
    const rootDir = projectRoot(f.projectId);
    expect(existsSync(path.join(rootDir, 'doc.md'))).toBe(true);
    const content = await import('node:fs').then((m) => m.readFileSync(path.join(rootDir, 'doc.md'), 'utf8'));
    expect(content).toBe('main-side\n'); // 未选边，主干保持冲突前状态
    const broadcast = db.prepare("SELECT content FROM conversation_message WHERE scope_id=? AND author='system'").all(f.projectId) as Array<{ content: string }>;
    expect(broadcast.some((b) => b.content.includes('升级给你') && b.content.includes('时间线'))).toBe(true);
    const evts = db.prepare("SELECT kind FROM task_event WHERE kind='conflict_judge_escalated'").all();
    expect(evts).toHaveLength(1);
  });
});
