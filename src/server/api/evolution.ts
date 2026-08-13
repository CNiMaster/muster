/**
 * E5 用户控制面 REST：组织进化系统的可见性 + 控制端点。
 *
 * - GET  /api/promotion-candidates?status=          晋升候选列表
 * - POST /api/promotion-candidates/:id/dismiss      忽略候选（永久退出晋升流，除非 reopen）
 * - POST /api/promotion-candidates/:id/reopen       恢复候选
 * - GET  /api/structure-changes?entityType&entityId&limit  结构变更历史
 * - POST /api/structure-changes/rollback            回滚到指定 version（支持类型才自动恢复）
 * - GET  /api/locks                                 全部锁定列表
 * - POST /api/locks                                 加锁（entityType/entityId/scope/lockedFields/reason）
 * - DELETE /api/locks                               解锁（三元组）
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  listPromotionCandidates,
  getPromotionCandidate,
  dismissPromotionCandidate,
  reopenPromotionCandidate,
  type PromotionStatus,
} from '../domain/promotion';
import { listStructureHistory, listRecentStructureChanges, applyStructureRollback } from '../domain/structure-versioning';
import { listAllLocks, lockEntity, unlockEntity, type LockScope } from '../domain/entity-lock';

export const promotionCandidatesRouter = Router();
export const structureChangesRouter = Router();
export const locksRouter = Router();

// ── 晋升候选 ─────────────────────────────────────────────────────────

promotionCandidatesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' && ['pending', 'promoted', 'dismissed'].includes(req.query.status)
      ? (req.query.status as PromotionStatus)
      : undefined;
    const companyId = typeof req.query.companyId === 'string' && req.query.companyId ? req.query.companyId : undefined;
    res.json(listPromotionCandidates(getDb(), { ...(status ? { status } : {}), ...(companyId ? { companyId } : {}) }));
  }),
);

promotionCandidatesRouter.post(
  '/:id/dismiss',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = param(req, 'id');
    dismissPromotionCandidate(db, id);
    res.json({ candidate: getPromotionCandidate(db, id) });
  }),
);

promotionCandidatesRouter.post(
  '/:id/reopen',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = param(req, 'id');
    reopenPromotionCandidate(db, id);
    res.json({ candidate: getPromotionCandidate(db, id) });
  }),
);

// ── 结构变更历史 + 回滚 ──────────────────────────────────────────────

structureChangesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : '';
    const entityId = typeof req.query.entityId === 'string' ? req.query.entityId : '';
    const limit = Math.min(Math.max(Number(typeof req.query.limit === 'string' ? req.query.limit : '50'), 1), 200);
    if (entityType && entityId) {
      res.json(listStructureHistory(db, { entityType, entityId }).slice(0, limit));
    } else {
      res.json(listRecentStructureChanges(db, limit));
    }
  }),
);

structureChangesRouter.post(
  '/rollback',
  asyncHandler(async (req, res) => {
    const input = z.object({
      entityType: z.string().min(1).max(100),
      entityId: z.string().min(1).max(200),
      toVersion: z.number().int().min(0),
    }).parse(req.body);
    const outcome = applyStructureRollback(getDb(), input);
    res.json(outcome);
  }),
);

// ── 锁定管理 ─────────────────────────────────────────────────────────

locksRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(listAllLocks(getDb()));
  }),
);

locksRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = z.object({
      entityType: z.string().min(1).max(100),
      entityId: z.string().min(1).max(200),
      scope: z.enum(['personal', 'org']),
      lockedFields: z.array(z.string().max(200)).optional(),
      reason: z.string().max(500).optional(),
    }).parse(req.body);
    const db = getDb();
    lockEntity(db, {
      entityType: input.entityType,
      entityId: input.entityId,
      scope: input.scope as LockScope,
      lockedFields: input.lockedFields,
      reason: input.reason,
    });
    res.json({ ok: true, locks: listAllLocks(db) });
  }),
);

locksRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const input = z.object({
      entityType: z.string().min(1).max(100),
      entityId: z.string().min(1).max(200),
      scope: z.enum(['personal', 'org']),
    }).parse(req.query);
    const db = getDb();
    unlockEntity(db, { entityType: input.entityType, entityId: input.entityId, scope: input.scope as LockScope });
    res.json({ ok: true, locks: listAllLocks(db) });
  }),
);
