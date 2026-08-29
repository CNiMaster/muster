/**
 * 阶段工作流 API 路由（批次④ M1 复审补测）：真实 router 上做 HTTP 级断言。
 * - GET /api/tasks/:id/stages 返回冻结快照行（404 语义：任务不存在）
 * - 推进后状态与 API 视图一致（queued 任务 + running 阶段）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeTestDb, createNovelCompany } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, claimNextTask, markRunning } from '../../src/server/domain/task';
import { evolveBlueprint, publishBlueprintDebugResult } from '../../src/server/domain/blueprint';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { listPersonas } from '../../src/server/domain/persona-library';
import { ensureStageRuns, advanceStageRun } from '../../src/server/domain/task-stage';
import { taskByIdRouter } from '../../src/server/api/tasks';
import { errorMiddleware } from '../../src/server/api/middleware';

let tdb: ReturnType<typeof makeTestDb>;
let server: http.Server;
let base: string;

beforeEach(async () => {
  tdb = makeTestDb();
  setDbForTest(tdb.db);
  const app = express();
  app.use(express.json());
  app.use('/api/tasks/:id', taskByIdRouter);
  app.use(errorMiddleware); // 与真实 server 同款错误映射（AppError→404 JSON）
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closeDb();
});

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('GET /api/tasks/:id/stages', () => {
  it('返回冻结阶段行；推进后反映 passed/running；不存在任务 404', async () => {
    const db = tdb.db;
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, { companyId: r.company.id, name: 'p', rootDir: '/tmp/tstage-api', firstAgentId: r.agents.lead.id, initialState: 'active' });
    const persona = listPersonas()[0]!;
    const bp = evolveBlueprint(db, { companyId: r.company.id, projectId: project.id, taskTitle: '阶段API测试_xyz', personaId: persona.id, personaName: persona.name, win: true })!;
    publishBlueprintDebugResult(db, {
      blueprintId: bp.id,
      staffing: [{ personaId: persona.id, personaName: persona.name }],
      stages: [
        { id: 's1', step: 1, label: '梳理' },
        { id: 's2', step: 2, label: '成稿' },
      ],
      summary: '布景',
    });
    const task = createTask(db, { projectId: project.id, title: '走流水线', blueprintId: bp.id });
    const leadThread = ensurePrimaryThread(db, project.id, r.agents.lead.id);
    for (let i = 0; i < 10; i++) {
      if (claimNextTask(db, leadThread.id, r.agents.lead.id)?.task.id === task.id) break;
    }
    markRunning(db, task.id);
    ensureStageRuns(db, getTask(db, task.id));

    const before = await getJson(`/api/tasks/${task.id}/stages`);
    expect(before.status).toBe(200);
    const rowsBefore = before.body as Array<{ step: number; status: string; label: string }>;
    expect(rowsBefore).toHaveLength(2);
    expect(rowsBefore[0]).toMatchObject({ step: 1, status: 'running', label: '梳理' });

    advanceStageRun(db, task.id, { summary: '阶段一完成', artifacts: [{ path: 'a.md' }] });
    const after = await getJson(`/api/tasks/${task.id}/stages`);
    const rowsAfter = after.body as Array<{ step: number; status: string }>;
    expect(rowsAfter[0].status).toBe('passed');
    expect(rowsAfter[1].status).toBe('running');

    const missing = await getJson('/api/tasks/tk_不存在/stages');
    expect(missing.status).toBe(404);
  });
});
