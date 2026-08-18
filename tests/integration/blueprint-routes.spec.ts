import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 公司退役批次A：蓝图路由双挂 + blueprint-optimization 参数修复回归。
 *
 * 背景 bug（f3e2c01 引入）：blueprintOptimizationRouter 挂载于 /api/companies/:companyId，
 * 但 handler 全部读 param(req,'id')——该挂载下 id 恒为空，
 * optimize-chat / optimization-items 五端点对所有请求必 404「蓝图不存在」。
 * 本文件在真实 router 上做 HTTP 级断言，先红后绿。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
;
import { evolveBlueprint } from '../../src/server/domain/blueprint';
import { blueprintOptimizationRouter } from '../../src/server/api/blueprint-optimization';
import { blueprintsRouter } from '../../src/server/api/blueprints';

let tdb: ReturnType<typeof makeTestDb>;
let server: http.Server;
let base: string;

beforeEach(async () => {
  tdb = makeTestDb();
  setDbForTest(tdb.db);
  const app = express();
  app.use(express.json());
  // 公司退役批次C：旧 /api/companies 路径已下线；新路径经 companyIdOf 解析默认工作台
  app.use('/api/blueprints', blueprintsRouter);
  app.use('/api/blueprint-optimization', blueprintOptimizationRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closeDb();
});

function seedBlueprint(): { companyId: string; blueprintId: string } {
  const db = tdb.db;
  const company = restoreWorkbench(db, { id: 'wb_fix_1', name: '默认工作台', kind: 'general' });
  const bp = evolveBlueprint(db, {
    companyId: company.id,
    projectId: 'p_seed',
    taskTitle: '做一次竞品调研并输出报告',
    personaId: 'persona_researcher',
    personaName: '调研员',
    win: true,
  });
  if (!bp) throw new Error('种子蓝图创建失败');
  return { companyId: company.id, blueprintId: bp.id };
}

describe('blueprint-optimization 路由（bug 回归：companyIdOf 解析）', () => {
  it('GET /api/blueprint-optimization/blueprints/:bid/optimize-chat 返回 200（修复前 old 路径必 404）', async () => {
    const { blueprintId } = seedBlueprint();
    const res = await fetch(`${base}/api/blueprint-optimization/blueprints/${blueprintId}/optimize-chat`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[]; pendingItems: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
    expect(Array.isArray(body.pendingItems)).toBe(true);
  });

  it('归属校验仍生效：不存在蓝图 404', async () => {
    const res = await fetch(`${base}/api/blueprint-optimization/blueprints/bp_non_existent/optimize-chat`);
    expect(res.status).toBe(404);
  });
});

describe('blueprints 路由（单例工作台）', () => {
  it('GET /api/blueprints 空库返回 []（companyIdOf 兜底顺带建默认工作台）', async () => {
    const res = await fetch(`${base}/api/blueprints`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /api/blueprints 返回默认工作台蓝图列表', async () => {
    const { blueprintId } = seedBlueprint();
    const res = await fetch(`${base}/api/blueprints`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string }>;
    expect(list.map((b) => b.id)).toContain(blueprintId);
  });
});