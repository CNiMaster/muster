/**
 * 批次 H.1：轮末变更卡服务端——numstat 封装 + round-changes 端点（含撤销 revert）。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { createTask } from '../../src/server/domain/task';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { commitAll, commitFileStats, commitFileDiff } from '../../src/server/worktree/manager';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { projectArtifactsRouter } from '../../src/server/api/artifacts';

let db: DB;
let rootDir: string;
let server: http.Server;
let base: string;

beforeEach(async () => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  rootDir = path.resolve('/tmp/muster-h1-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(rootDir, { recursive: true });
  execSync('git init -q .', { cwd: rootDir });
  execSync('git config user.email t@t', { cwd: rootDir });
  execSync('git config user.name t', { cwd: rootDir });
});

afterEach(async () => {
  closeDb();
  if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true });
});

describe('commitFileStats / commitFileDiff（批次 H.1）', () => {
  it('numstat 行数统计与单文件 diff', () => {
    writeFileSync(path.join(rootDir, 'a.md'), 'line1\n');
    writeFileSync(path.join(rootDir, 'b.txt'), 'x\n');
    const base = commitAll(rootDir, 'init');
    appendFileSync(path.join(rootDir, 'a.md'), 'line2\nline3\n');
    writeFileSync(path.join(rootDir, 'new.ts'), 'const a = 1;\n');
    const head = commitAll(rootDir, 'round');

    const stats = commitFileStats(rootDir, base, head);
    const byPath = new Map(stats.map((s) => [s.path, s]));
    expect(byPath.get('a.md')).toMatchObject({ adds: 2, dels: 0 });
    expect(byPath.get('new.ts')).toMatchObject({ adds: 1, dels: 0 });
    expect(byPath.has('b.txt')).toBe(false);

    const diff = commitFileDiff(rootDir, base, head, 'a.md');
    expect(diff).toContain('+line2');
  });
});

describe('round-changes 端点（批次 H.1）', () => {
  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/projects/:id/artifacts', projectArtifactsRouter);
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = (err as { status?: number }).status ?? 500;
      res.status(status).json({ error: { code: 'test', message: (err as Error).message } });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function seed(): { projectId: string; taskId: string } {
    const wb = restoreWorkbench(db, { id: 'wb_h1', name: 'co' });
    const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
    const project = createProject(db, { companyId: wb.id, name: 'p', rootDir, firstAgentId: lead.id, initialState: 'active' });
    const pt = createProjectTask(db, { projectId: project.id, title: '任务一' });
    const task = createTask(db, { projectId: project.id, projectTaskId: pt.id, title: '执行', assigneeAgentId: lead.id });
    // 造一轮发布记录：base=首轮 commit，head=第二轮 commit
    writeFileSync(path.join(rootDir, 'doc.md'), 'v1\n');
    const base = commitAll(rootDir, 'base');
    appendFileSync(path.join(rootDir, 'doc.md'), 'v2\n');
    const head = commitAll(rootDir, 'round1');
    db.prepare(
      `INSERT INTO publish_record (id, task_id, thread_id, project_root, commit_hash, merged_files_json,
        conflicts_json, blocked, rolled_back, status, artifacts_json, source_base_commit, published_at)
       VALUES ('pub_1', ?, 'th_1', ?, ?, '["doc.md"]', '[]', 0, 0, 'published', '[]', ?, ?)`,
    ).run(task.id, rootDir, head, base, new Date().toISOString());
    return { projectId: project.id, taskId: task.id };
  }

  it('GET round-changes 返回文件与行数；undo 后 rolledBack 且 git 出现 Revert', async () => {
    const { projectId, taskId } = seed();
    const res = await fetch(`${base}/api/projects/${projectId}/artifacts/round-changes?taskId=${taskId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publishId: string; files: Array<{ path: string; adds: number | null }> };
    expect(body.publishId).toBe('pub_1');
    expect(body.files).toContainEqual({ path: 'doc.md', adds: 1, dels: 0 });

    const undo = await fetch(`${base}/api/projects/${projectId}/artifacts/round-changes/undo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }),
    });
    expect(undo.status).toBe(200);
    const rolled = (db.prepare('SELECT rolled_back FROM publish_record WHERE id=?').get('pub_1') as { rolled_back: number }).rolled_back;
    expect(rolled).toBe(1);
    // 带 projectTaskId 的发布 commit 在任务集成分支上——revert 发生在 staging worktree（设计语义），从主仓库看集成分支日志
    const branch = execSync('git branch --list "muster/*/pt-*"', { cwd: rootDir, encoding: 'utf8' }).trim().split('\n')[0]!.replace(/^[*+]\s+/, '');
    const log = execSync(`git log --oneline ${branch}`, { cwd: rootDir, encoding: 'utf8' });
    expect(log).toMatch(/Revert/i);
    // 重复撤销 409
    const again = await fetch(`${base}/api/projects/${projectId}/artifacts/round-changes/undo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }),
    });
    expect(again.status).toBe(409);
  });

  it('无记录返回空 files；file diff 端点返回文本', async () => {
    const { projectId, taskId } = seed();
    const diffRes = await fetch(`${base}/api/projects/${projectId}/artifacts/round-changes/file?taskId=${taskId}&path=${encodeURIComponent('doc.md')}`);
    expect(diffRes.status).toBe(200);
    expect(((await diffRes.json()) as { diff: string }).diff).toContain('+v2');
  });
});
