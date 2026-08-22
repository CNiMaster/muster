/**
 * 批次 H8：停止/纠错 REST 端点 HTTP 级测试（域层拦不住方法不匹配——评审 C1 教训）。
 * 覆盖：/stop（受理回执+标志+immediate）、/stop-all（全局安全停/急停）、/pause rewire（运行中改走安全停）、
 * /discard-stop（回退）、/correct（上级路由四分支+负责人拦截）。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { projectsRouter } from '../../src/server/api/projects';
import { taskByIdRouter } from '../../src/server/api/tasks';

let db: DB;
let server: http.Server;
let base: string;
let projectId: string;
let leadId: string;
let hrRequestId = 0;

beforeEach(async () => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  const wb = restoreWorkbench(db, { id: 'wb_h8route', name: 'co' });
  const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
  leadId = lead.id;
  projectId = createProject(db, { companyId: wb.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' }).id;

  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
  app.use('/api/tasks/:id', taskByIdRouter);
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

function insertTask(id: string, state: string, assignee?: string, dispatcher?: string): void {
  db.prepare(
    "INSERT INTO task (id, project_id, seq, title, state, assignee_agent_id, dispatcher_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, projectId, ++hrRequestId, `t-${id}`, state, assignee ?? null, dispatcher ?? null, new Date().toISOString(), new Date().toISOString());
}

const post = async (path: string, body: unknown = {}): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('H8 /stop 与 /stop-all', () => {
  it('POST /api/tasks/:id/stop——置 stop_requested+受理回执+engine 缺席时优雅降级', async () => {
    insertTask('tk_s1', 'running');
    const r = await post('/api/tasks/tk_s1/stop');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; signalled: boolean; task: { stopRequested: boolean } };
    expect(body.ok).toBe(true);
    expect(body.signalled).toBe(false); // 测试环境无 engine 实例——只置位不炸
    expect(body.task.stopRequested).toBe(true);
    const row = db.prepare("SELECT stop_requested FROM task WHERE id='tk_s1'").get() as { stop_requested: number };
    expect(row.stop_requested).toBe(1);
  });

  it('POST /api/tasks/:id/stop immediate——立即停止标记透传', async () => {
    insertTask('tk_s2', 'running');
    const r = await post('/api/tasks/tk_s2/stop', { immediate: true });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { immediate: boolean }).immediate).toBe(true);
  });

  it('POST /api/projects/:id/tasks/stop-all——本项目全部 running/claimed 置位，其他状态不动', async () => {
    insertTask('tk_a', 'running');
    insertTask('tk_b', 'claimed');
    insertTask('tk_c', 'queued');
    insertTask('tk_d', 'paused');
    const r = await post(`/api/projects/${projectId}/tasks/stop-all`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stopped: number; total: number };
    expect(body.stopped).toBe(2);
    expect(body.total).toBe(2);
    const states = db.prepare('SELECT id, stop_requested FROM task WHERE project_id=? ORDER BY id').all(projectId) as Array<{ id: string; stop_requested: number }>;
    expect(states.find((s) => s.id === 'tk_a')!.stop_requested).toBe(1);
    expect(states.find((s) => s.id === 'tk_b')!.stop_requested).toBe(1);
    expect(states.find((s) => s.id === 'tk_c')!.stop_requested).toBe(0); // 排队不动
    expect(states.find((s) => s.id === 'tk_d')!.stop_requested).toBe(0); // 已停不动
  });
});

describe('H8 /pause rewire（pauseTask 缺陷修复）', () => {
  it('运行中 pause → 安全停（置 stop_requested），不再只改状态', async () => {
    insertTask('tk_p1', 'running');
    const r = await post('/api/tasks/tk_p1/pause');
    expect(r.status).toBe(200);
    const row = db.prepare("SELECT state, stop_requested FROM task WHERE id='tk_p1'").get() as { state: string; stop_requested: number };
    expect(row.stop_requested).toBe(1); // 关键：通知停止链路（域 pauseTask 只改 state 的缺陷已修）
  });

  it('等待态 pause → 状态机拦截（waiting_input 本就停着等输入，paused 不是其合法迁移）', async () => {
    insertTask('tk_p2', 'waiting_input');
    const r = await post('/api/tasks/tk_p2/pause');
    expect(r.status).toBeGreaterThanOrEqual(400);
    const row = db.prepare("SELECT state FROM task WHERE id='tk_p2'").get() as { state: string };
    expect(row.state).toBe('waiting_input');
  });
});

describe('H8 /discard-stop（打断记录「回退」）', () => {
  it('paused 无现场任务 → 直接回 queued', async () => {
    insertTask('tk_d1', 'paused');
    const r = await post('/api/tasks/tk_d1/discard-stop');
    expect(r.status).toBe(200);
    expect(((await r.json()) as { state: string }).state).toBe('queued');
  });

  it('非 paused 态拒绝', async () => {
    insertTask('tk_d2', 'running');
    const r = await post('/api/tasks/tk_d2/discard-stop');
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe('H8 /correct（纠错上级路由）', () => {
  it('普通执行者无派遣 → 第一负责人收令', async () => {
    const writer = createAgent(db, { companyId: 'wb_h8route', name: 'writer', role: 'writer' });
    insertTask('tk_c1', 'running', writer.id, null);
    const r = await post('/api/tasks/tk_c1/correct', { problem: '他改错了文件' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { recipientId: string; correctionTaskId: string | null };
    expect(body.recipientId).toBe(leadId);
    expect(body.correctionTaskId).not.toBeNull();
    const created = db.prepare('SELECT input_protocol_json FROM task WHERE id=?').get(body.correctionTaskId!) as { input_protocol_json: string };
    expect(created.input_protocol_json).toContain('纠错');
    expect(created.input_protocol_json).toContain('他改错了文件');
  });

  it('有派遣人 → 派遣领导收令', async () => {
    const writer = createAgent(db, { companyId: 'wb_h8route', name: 'w2', role: 'writer' });
    const senior = createAgent(db, { companyId: 'wb_h8route', name: 'senior', role: 'writer' });
    insertTask('tk_c2', 'running', writer.id, senior.id);
    const r = await post('/api/tasks/tk_c2/correct', { problem: '方向反了' });
    expect(((await r.json()) as { recipientId: string }).recipientId).toBe(senior.id);
  });

  it('第一负责人本人 → 拒绝纠错（与用户直接沟通）', async () => {
    insertTask('tk_c3', 'running', leadId, null);
    const r = await post('/api/tasks/tk_c3/correct', { problem: 'x' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain('直接沟通');
  });

  it('在跑任务纠错 → 先安全停（置 stop_requested）', async () => {
    const writer = createAgent(db, { companyId: 'wb_h8route', name: 'w3', role: 'writer' });
    insertTask('tk_c4', 'running', writer.id, null);
    await post('/api/tasks/tk_c4/correct', { problem: '停了再说' });
    const row = db.prepare("SELECT stop_requested FROM task WHERE id='tk_c4'").get() as { stop_requested: number };
    expect(row.stop_requested).toBe(1);
  });
});
