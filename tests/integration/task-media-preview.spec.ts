/**
 * 批次 H.4：worktree 媒体自动预览回流。
 * 覆盖：扫描函数（媒体扩展名过滤/嵌套目录/.git 跳过/跨调用去重）+ 任务级文件端点
 * （200 读取、无 runtime 404、路径逃逸 403、目录 404、HTML 附 CSP）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { saveTaskRuntime } from '../../src/server/domain/task-runtime';
import { listTrace } from '../../src/server/domain/execution-trace';
import { scanWorktreeMediaPreviews } from '../../src/server/runtime/media-preview';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { taskByIdRouter } from '../../src/server/api/tasks';

let db: DB;
let taskId: string;
let rootDir: string;

beforeEach(() => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  const wb = restoreWorkbench(db, { id: 'wb_h4', name: 'co' });
  const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
  const project = createProject(db, { companyId: wb.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id });
  taskId = createTask(db, { projectId: project.id, title: '生图任务', assigneeAgentId: lead.id }).id;
  rootDir = path.resolve('/tmp/muster-h4-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(path.join(rootDir, 'assets'), { recursive: true });
  mkdirSync(path.join(rootDir, '.git'), { recursive: true });
  saveTaskRuntime(db, { taskId, branch: 'muster/x/y', path: rootDir, baseCommit: 'HEAD' });
});

afterEach(() => {
  closeDb();
  if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true });
});

describe('scanWorktreeMediaPreviews（批次 H.4）', () => {
  it('媒体过滤 + 嵌套 + .git 跳过 + 跨调用去重', () => {
    writeFileSync(path.join(rootDir, 'assets', 'shot.png'), 'png');
    mkdirSync(path.join(rootDir, 'assets', 'deep'), { recursive: true });
    writeFileSync(path.join(rootDir, 'assets', 'deep', '图.svg'), '<svg/>');
    writeFileSync(path.join(rootDir, 'notes.txt'), '文本不发');
    writeFileSync(path.join(rootDir, '.git', 'evil.png'), '不应扫到');

    const emitted = new Set<string>();
    expect(scanWorktreeMediaPreviews(db, taskId, null, rootDir, emitted)).toBe(2);
    const previews = listTrace(db, taskId, { kind: 'preview' }) as Array<{ payload: Record<string, unknown> }>;
    const paths = previews.map((p) => p.payload.path);
    expect(paths).toContain('assets/shot.png');
    expect(paths).toContain('assets/deep/图.svg');
    expect(paths.some((p) => String(p).startsWith('.git/'))).toBe(false);
    expect(previews.every((p) => p.payload.origin === 'worktree')).toBe(true);

    // 再扫（无新增）不重复；新文件只发新者
    expect(scanWorktreeMediaPreviews(db, taskId, null, rootDir, emitted)).toBe(0);
    writeFileSync(path.join(rootDir, 'assets', '图2.jpg'), 'jpg');
    expect(scanWorktreeMediaPreviews(db, taskId, null, rootDir, emitted)).toBe(1);
  });
});

describe('GET /api/tasks/:id/files/*path（批次 H.4）', () => {
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    const app = express();
    app.use('/api/tasks/:id', taskByIdRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('读取 worktree 文件 200；HTML 附 CSP', async () => {
    writeFileSync(path.join(rootDir, 'assets', 'shot.png'), 'png');
    writeFileSync(path.join(rootDir, 'page.html'), '<script>x</script>');
    const img = await fetch(`${base}/api/tasks/${taskId}/files/assets/shot.png`);
    expect(img.status).toBe(200);
    const html = await fetch(`${base}/api/tasks/${taskId}/files/page.html`);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('目录 404；符号链接逃逸 403；无 runtime 404（任务回收语义）', async () => {
    mkdirSync(path.join(rootDir, 'docs'), { recursive: true });
    writeFileSync(path.join(rootDir, 'assets', 'shot.png'), 'png');
    const outside = path.resolve('/tmp/muster-h4-out-' + Math.random().toString(36).slice(2, 8));
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 's.txt'), '库外');
    symlinkSync(path.join(outside, 's.txt'), path.join(rootDir, 'docs', 'evil.txt'));
    try {
      const dir = await fetch(`${base}/api/tasks/${taskId}/files/docs`);
      expect(dir.status).toBe(404);
      const evil = await fetch(`${base}/api/tasks/${taskId}/files/${encodeURIComponent('docs/evil.txt')}`);
      expect(evil.status).toBe(403);
      db.prepare('DELETE FROM task_runtime WHERE task_id=?').run(taskId);
      const gone = await fetch(`${base}/api/tasks/${taskId}/files/assets/shot.png`);
      expect(gone.status).toBe(404);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
