/**
 * 临时工 + 评级 REST 路由（批次 A）。
 *
 * - POST   /api/employees/temp       招聘临时工
 * - POST   /api/employees/:id/convert 转正
 * - POST   /api/employees/:id/dismiss 开除临时工（confirm=true）
 * - GET    /api/employees/temp        列出临时工（含 greyed）
 * - POST   /api/agent-profiles/:id/rating                 用户手动调星级
 *
 * 详见 docs/superpowers/specs/2026-08-10-temp-worker-and-handover-design.md。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, companyIdOf } from './middleware';
import { getDb } from '../db/client';
import {
  createTempEmployment,
  convertTempToPermanent,
  dismissTempWorker,
  markTempGreyed,
  reactivateGreyedTemp,
} from '../domain/temp-worker';
import { adjustRating, calculateRating, applyRating } from '../domain/employee-rating';
import { getAgent } from '../domain/agent';
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';
import { AppError, ErrorCode } from '../../shared/errors';

export const tempWorkerRouter = Router();

// 招聘临时工（公司退役批次A双挂：旧 /companies/:companyId/employees/temp 与新 /employees/temp，companyId 经 companyIdOf 兜底）
const recruitSchema = z.object({
  role: z.string().min(1),
  responsibilities: z.string().optional(),
  profileId: z.string().optional(), // 复用现有人；不传则新建
  sourceContractId: z.string().optional(),
  skills: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  executor: z.record(z.unknown()).optional(),
  permissions: z.record(z.unknown()).optional(),
});
const recruitTempHandler = asyncHandler(async (req, res) => {
  const input = recruitSchema.parse(req.body);
  const result = createTempEmployment(getDb(), {
    companyId: companyIdOf(req),
    ...input,
  });
  realtime.publish(makeLifecycleEvent('employee.temp-recruited', {
    agentId: result.agentId,
    profileId: result.profileId,
    companyId: companyIdOf(req),
    isNewProfile: result.isNewProfile,
  }, { companyId: companyIdOf(req) }));
  res.status(201).json(result);
});
tempWorkerRouter.post('/employees/temp', recruitTempHandler);

// 转正
const convertTempHandler = asyncHandler(async (req, res) => {
  const agentId = param(req, 'id');
  convertTempToPermanent(getDb(), agentId);
  const agent = getAgent(getDb(), agentId);
  realtime.publish(makeLifecycleEvent('employee.converted', {
    agentId,
    profileId: agent.profileId,
    companyId: companyIdOf(req),
  }, { companyId: companyIdOf(req) }));
  res.json({ ok: true });
});
tempWorkerRouter.post('/employees/:id/convert', convertTempHandler);

// 开除临时工（二次确认）
const dismissSchema = z.object({ confirm: z.boolean() });
const dismissTempHandler = asyncHandler(async (req, res) => {
  const agentId = param(req, 'id');
  const input = dismissSchema.parse(req.body);
  const agent = getAgent(getDb(), agentId);
  const profileId = agent.profileId;
  // 判断是否会删 profile（is_temp_only=1 且无其他任职）
  const row = getDb().prepare(
    `SELECT ap.is_temp_only,
      (SELECT COUNT(*) FROM company_employee WHERE profile_id=ap.id) AS emp_count
     FROM agent_profile ap WHERE ap.id=?`,
  ).get(profileId) as { is_temp_only: number; emp_count: number } | undefined;
  const profileDeleted = !!(row?.is_temp_only === 1 && row?.emp_count <= 1);

  dismissTempWorker(getDb(), agentId, { confirm: input.confirm });
  realtime.publish(makeLifecycleEvent('employee.dismissed', {
    agentId,
    profileId,
    companyId: companyIdOf(req),
    profileDeleted,
  }, { companyId: companyIdOf(req) }));
  res.json({ ok: true, profileDeleted });
});
tempWorkerRouter.post('/employees/:id/dismiss', dismissTempHandler);

// 重新激活 greyed 临时工（选拔优先级链第二级：复用而非新建）
const reactivateTempHandler = asyncHandler(async (req, res) => {
  const agentId = param(req, 'id');
  reactivateGreyedTemp(getDb(), agentId);
  res.json({ ok: true });
});
tempWorkerRouter.post('/employees/:id/reactivate', reactivateTempHandler);

// 列出临时工（含 greyed）
const listTempHandler = asyncHandler(async (req, res) => {
  const rows = getDb().prepare(
    `SELECT ce.*, ad.name, ad.profile_id, ap.display_name, ap.rating
     FROM company_employee ce
     JOIN agent_definition ad ON ad.id = ce.legacy_agent_id
     JOIN agent_profile ap ON ap.id = ce.profile_id
     WHERE ce.company_id = ? AND ce.employment_type = 'temp'
     ORDER BY ce.temp_status, ce.created_at DESC`,
  ).all(companyIdOf(req));
  res.json(rows);
});
tempWorkerRouter.get('/employees/temp', listTempHandler);

// 手动调星级
const ratingSchema = z.object({ rating: z.number().int().min(1).max(5) });

tempWorkerRouter.post(
  '/agent-profiles/:id/rating',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'id');
    const input = ratingSchema.parse(req.body);
    const old = getDb().prepare('SELECT rating FROM agent_profile WHERE id=?').get(profileId) as { rating: number } | undefined;
    if (!old) throw new AppError(ErrorCode.NOT_FOUND, `profile ${profileId} 不存在`);
    adjustRating(getDb(), profileId, input.rating);
    realtime.publish(makeLifecycleEvent('employee.rating-adjusted', {
      profileId,
      oldRating: old.rating,
      newRating: input.rating,
    }, {}));
    res.json({ ok: true, rating: input.rating });
  }),
);

// 评级明细查询
tempWorkerRouter.get(
  '/agent-profiles/:id/rating',
  asyncHandler(async (req, res) => {
    const breakdown = calculateRating(getDb(), param(req, 'id'));
    // 同时返回 DB 存储的 rating（可能被用户手动 adjust 过，不同于实时计算值）
    const row = getDb().prepare('SELECT rating FROM agent_profile WHERE id=?').get(param(req, 'id')) as { rating: number } | undefined;
    res.json({ ...breakdown, storedRating: row?.rating ?? 1 });
  }),
);

// 重算评级（批量）
tempWorkerRouter.post(
  '/agent-profiles/rating/recalculate',
  asyncHandler(async (_req, res) => {
    const profiles = getDb().prepare('SELECT id FROM agent_profile').all() as { id: string }[];
    let count = 0;
    for (const p of profiles) {
      applyRating(getDb(), p.id);
      count++;
    }
    res.json({ ok: true, recalculated: count });
  }),
);
