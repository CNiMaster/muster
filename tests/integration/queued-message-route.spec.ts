/**
 * 批次 H 评审修：排队 REST 六端点 HTTP 级测试（C1 的 PUT/PATCH 不匹配只有这层能拦住）。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { restoreWorkbench, clockIn } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { projectsRouter } from '../../src/server/api/projects';

let db: DB;
let server: http.Server;
let base: string;
let projectId: string;

beforeEach(async () => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  const wb = restoreWorkbench(db, { id: 'wb_hfix', name: 'co' });
  const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
  projectId = createProject(db, { companyId: wb.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' }).id;
  clockIn(db);

  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
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
  closeDb();
});

describe('排队 REST 端点（批次 H 评审修）', () => {
  it('全链：POST 入队（含 refs）→ GET 列表 → PATCH 重编（C1 方法匹配）→ POST reorder → DELETE', async () => {
    // 入队（带 refs——C2 透传）
    const en = await fetch(`${base}/api/projects/${projectId}/queued-messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '第一条', refs: ['file:docs/a.md'] }),
    });
    expect(en.status).toBe(201);
    const a = (await en.json()) as { id: string; refs: string[] };
    expect(a.refs).toEqual(['file:docs/a.md']);

    const en2 = await fetch(`${base}/api/projects/${projectId}/queued-messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '第二条' }),
    });
    const b = (await en2.json()) as { id: string };

    // 列表
    const list = await fetch(`${base}/api/projects/${projectId}/queued-messages`);
    expect(((await list.json()) as unknown[]).length).toBe(2);

    // PATCH 重编（C1：此前客户端 PUT 服务端 PATCH 必 404）
    const edit = await fetch(`${base}/api/projects/${projectId}/queued-messages/${a.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '第一条（改）' }),
    });
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as { content: string }).content).toBe('第一条（改）');

    // reorder：b 提前
    const re = await fetch(`${base}/api/projects/${projectId}/queued-messages/reorder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: [b.id, a.id] }),
    });
    expect(((await re.json()) as Array<{ content: string }>)[0]!.content).toBe('第二条');

    // DELETE
    const del = await fetch(`${base}/api/projects/${projectId}/queued-messages/${a.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const list2 = await fetch(`${base}/api/projects/${projectId}/queued-messages`);
    expect(((await list2.json()) as unknown[]).length).toBe(1);
  });

  it('flush（↑立即）：打断运行中任务并送出；refs 随消息进任务 inputProtocol', async () => {
    const en = await fetch(`${base}/api/projects/${projectId}/queued-messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '立即这条', refs: ['task:tk_nonexist', 'file:x.md'] }),
    });
    const m = (await en.json()) as { id: string };
    // 造一个 running 任务
    db.prepare("INSERT INTO task (id, project_id, seq, title, state, created_at, updated_at) VALUES ('tk_r1', ?, 1, '跑着', 'running', ?, ?)")
      .run(projectId, new Date().toISOString(), new Date().toISOString());

    const fl = await fetch(`${base}/api/projects/${projectId}/queued-messages/${m.id}/flush`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(fl.status).toBe(200);
    // running 任务被打断回 queued（interruptTask 域语义）
    expect((db.prepare('SELECT state FROM task WHERE id=?').get('tk_r1') as { state: string }).state).toBe('queued');
    // 送出：生成了用户消息任务，refs 透传进 inputProtocol
    const created = db.prepare("SELECT input_protocol_json FROM task WHERE title LIKE '%立即这条%'").get() as { input_protocol_json: string };
    const protocol = JSON.parse(created.input_protocol_json) as { refs?: string[]; content: string };
    expect(protocol.refs).toEqual(['task:tk_nonexist', 'file:x.md']);
    expect(protocol.content).toContain('引用文件：x.md'); // refs 被服务端展开为引用段而非原样 token
  });
});
