/**
 * 批次 J 集成：专家借调流（J1：borrow 域+蜂群 acquire 兜底+API）与记忆盘点
 * （J2：归档触发生成/idle sweep 去重/resolve 四动作/批量按建议）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { transitionProjectPhase } from '../../src/server/domain/project-readiness';
import {
  createProjectSpecialist,
  forcePromoteToStaff,
  recordSpecialistUse,
  borrowStaffSpecialist,
  acquireSpecialistForPersona,
  getSpecialistEntry,
} from '../../src/server/domain/specialist-pool';
import {
  createArchiveDispositions,
  sweepIdleStaffSpecialists,
  listSpecialistReviews,
  resolveSpecialistReview,
  resolveProjectReviews,
} from '../../src/server/domain/specialist-review';
import { projectById } from '../../src/server/api/projects';
import { specialistReviewsRouter } from '../../src/server/api/specialist-reviews';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let server: http.Server;
let base: string;

beforeEach(async () => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(tdb.db);
  restoreWorkbench(db, { id: 'wb_j', name: '默认工作台' });

  const app = express();
  app.use(express.json());
  app.use('/api/projects/:id', projectById);
  app.use('/api/specialist-reviews', specialistReviewsRouter);
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
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closeDb();
});

function mkProject(name: string): string {
  return createProject(db, { companyId: 'wb_j', name, rootDir: `/tmp/muster-j-${name}-${Date.now()}`, initialState: 'active' }).id;
}

/** 造一个 staff 级专家（项目 A，use 记账到晋升阈值以上后强制 staff）。 */
function mkStaff(projectId: string, specialty: string, personaId?: string): string {
  const entry = createProjectSpecialist(db, { projectId, specialty, personaId: personaId ?? null, via: 'manual' });
  forcePromoteToStaff(db, entry.id);
  return entry.id;
}

describe('J1 借调流', () => {
  it('borrowStaffSpecialist：留痕+use 记账；非 staff/同项目被拒', () => {
    const a = mkProject('a');
    const b = mkProject('b');
    const staffId = mkStaff(a, '翻译');
    const before = getSpecialistEntry(db, staffId).useCount;
    const r = borrowStaffSpecialist(db, { specialistId: staffId, toProjectId: b });
    expect(r.agentId).toBeTruthy();
    expect(getSpecialistEntry(db, staffId).useCount).toBe(before + 1);
    const row = db.prepare('SELECT * FROM specialist_borrow WHERE specialist_id=?').get(staffId) as { from_project_id: string; to_project_id: string };
    expect(row.from_project_id).toBe(a);
    expect(row.to_project_id).toBe(b);
    expect(() => borrowStaffSpecialist(db, { specialistId: staffId, toProjectId: a })).toThrow(/不算借调/);

    const projectTier = createProjectSpecialist(db, { projectId: b, specialty: '普通项目专家', via: 'manual' });
    expect(() => borrowStaffSpecialist(db, { specialistId: projectTier.id, toProjectId: a })).toThrow(/staff/);
  });

  it('蜂群 acquire：本项目池无可执行专家 → 全局 staff 借调（persona 优先），不建本项目计数行；本项目有自己的专家则不借', () => {
    const a = mkProject('pool');
    const b = mkProject('borrower');
    mkStaff(a, '前端翻译', 'persona_tr');

    // b 池为空 → 借调命中（persona 匹配）
    const got = acquireSpecialistForPersona(db, b, 'persona_tr', '前端翻译');
    expect(got?.borrowed).toBe(true);
    expect(got?.agentId).toBeTruthy();
    const bCount = db.prepare("SELECT COUNT(*) n FROM specialist_pool WHERE project_id=?").get(b) as { n: number };
    expect(bCount.n).toBe(0); // 借调不虚增本项目需求计数

    // b 自己的池有了同 persona 可执行专家 → 本项目池优先直接用（不再借）
    const own = createProjectSpecialist(db, { projectId: b, specialty: '本地翻译专家', personaId: 'persona_tr', via: 'manual' });
    const got2 = acquireSpecialistForPersona(db, b, 'persona_tr', '前端翻译');
    expect(got2?.agentId).toBe(own.agentId);
    expect(got2?.borrowed).toBeUndefined();
  });

  it('手动借调 API：POST /api/projects/:id/specialists/:sid/borrow → 201', async () => {
    const a = mkProject('api-a');
    const b = mkProject('api-b');
    const staffId = mkStaff(a, '审计');
    const res = await fetch(`${base}/api/projects/${b}/specialists/${staffId}/borrow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agentId: string };
    expect(body.agentId).toBeTruthy();
  });
});

describe('J2 记忆盘点', () => {
  it('归档触发（HTTP PATCH state=archived）：为该项目全部在册专家生成待处置清单（三档建议）', async () => {
    const p = mkProject('arch');
    const heavy = createProjectSpecialist(db, { projectId: p, specialty: '重度使用', via: 'manual' });
    for (let i = 0; i < 5; i++) recordSpecialistUse(db, heavy.id);
    createProjectSpecialist(db, { projectId: p, specialty: '轻度使用', via: 'manual' });

    const res = await fetch(`${base}/api/projects/${p}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'archived' }),
    });
    expect(res.status).toBe(200);

    const pendings = listSpecialistReviews(db, { status: 'pending', projectId: p });
    expect(pendings.length).toBe(2);
    expect(pendings.some((r) => r.suggestion.includes('晋升'))).toBe(true);
    expect(pendings.some((r) => r.suggestion.includes('归档'))).toBe(true);
  });

  it('idle sweep：30 天未借调 staff 生成盘点，去重不重提', () => {
    const a = mkProject('idle');
    const staffId = mkStaff(a, '闲置专家');
    db.prepare('UPDATE specialist_pool SET updated_at=? WHERE id=?').run(new Date(Date.now() - 40 * 24 * 3600_000).toISOString(), staffId);
    const r1 = sweepIdleStaffSpecialists(db);
    expect(r1.created).toBe(1);
    const r2 = sweepIdleStaffSpecialists(db); // 去重
    expect(r2.created).toBe(0);
    const rows = listSpecialistReviews(db, { status: 'pending' });
    expect(rows.some((x) => x.kind === 'idle-inventory' && x.specialty === '闲置专家')).toBe(true);
  });

  it('resolve 四动作：promote 强制 staff / archive+dismiss 下岗 / keep 仅关单；重复处置 409；批量按建议', () => {
    const p = mkProject('resolve');
    const e1 = createProjectSpecialist(db, { projectId: p, specialty: '待晋升', via: 'manual' });
    const e2 = createProjectSpecialist(db, { projectId: p, specialty: '待归档', via: 'manual' });
    createArchiveDispositions(db, p);
    const pendings = listSpecialistReviews(db, { status: 'pending', projectId: p });
    expect(pendings.length).toBe(2);

    const r1 = resolveSpecialistReview(db, pendings.find((x) => x.specialistId === e1.id)!.id, 'promote');
    expect(r1.resolution).toBe('promote');
    expect(getSpecialistEntry(db, e1.id).tier).toBe('staff');

    resolveSpecialistReview(db, pendings.find((x) => x.specialistId === e2.id)!.id, 'archive');
    expect(getSpecialistEntry(db, e2.id).status).toBe('dismissed');

    expect(() => resolveSpecialistReview(db, r1.id, 'keep')).toThrow(/已处置/);

    // 批量：再造两条按建议一键执行
    const p2 = mkProject('resolve-all');
    createProjectSpecialist(db, { projectId: p2, specialty: '批量A', via: 'manual' });
    createProjectSpecialist(db, { projectId: p2, specialty: '批量B', via: 'manual' });
    createArchiveDispositions(db, p2);
    const r = resolveProjectReviews(db, p2);
    expect(r.resolved).toBe(2);
    expect(listSpecialistReviews(db, { status: 'pending', projectId: p2 })).toHaveLength(0);
  });

  it('盘点 API：GET/resolve/sweep-idle 往返', async () => {
    const a = mkProject('api-j2');
    const staffId = mkStaff(a, 'API 闲置');
    db.prepare('UPDATE specialist_pool SET updated_at=? WHERE id=?').run(new Date(Date.now() - 35 * 24 * 3600_000).toISOString(), staffId);

    const sweep = await fetch(`${base}/api/specialist-reviews/sweep-idle`, { method: 'POST' });
    expect(sweep.status).toBe(200);
    const list = await fetch(`${base}/api/specialist-reviews?status=pending`);
    const rows = (await list.json()) as Array<{ id: string; kind: string; specialty: string }>;
    expect(rows.some((x) => x.kind === 'idle-inventory' && x.specialty === 'API 闲置')).toBe(true);

    const id = rows.find((x) => x.kind === 'idle-inventory')!.id;
    const res = await fetch(`${base}/api/specialist-reviews/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'keep' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resolution: string }).resolution).toBe('keep');
  });
});
