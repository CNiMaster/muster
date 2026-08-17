/**
 * 蓝图优化 API（挂 /api/companies/:id，mergeParams）。
 * 2026-08-17 定案：退役公司级「一键体检」与 consult 整体检测，改为每蓝图独立优化对话。
 * - GET  /blueprints/:blueprintId/optimize-chat   会话历史 + 待处理提案
 * - POST /blueprints/:blueprintId/optimize-chat   发言（AI 回复 + 提案落暂存表，LLM 失败降级规则）
 * - GET  /optimization-items?blueprintId=          提案列表（可按蓝图过滤）
 * - POST /optimization-items/:itemId/apply         采纳（版本化落地）
 * - POST /optimization-items/:itemId/ignore        忽略
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { listOptimizationItems, applyOptimizationItem, ignoreOptimizationItem } from '../domain/blueprint-optimizer';
import { listOptimizeChat, sendOptimizeChatMessage } from '../domain/blueprint-optimize-chat';
import { getBlueprint } from '../domain/blueprint';
import { AppError, ErrorCode } from '../../shared/errors';
import { asyncHandler, param } from './middleware';

export const blueprintOptimizationRouter = Router({ mergeParams: true });

function assertBlueprintCompany(blueprintId: string, companyId: string): void {
  const bp = getBlueprint(getDb(), blueprintId);
  if (bp.companyId !== companyId) throw new AppError(ErrorCode.NOT_FOUND, '蓝图不存在');
}

blueprintOptimizationRouter.get(
  '/blueprints/:blueprintId/optimize-chat',
  asyncHandler(async (req, res) => {
    const companyId = param(req, 'id');
    const blueprintId = param(req, 'blueprintId');
    assertBlueprintCompany(blueprintId, companyId);
    res.json({
      messages: listOptimizeChat(getDb(), blueprintId),
      pendingItems: listOptimizationItems(getDb(), companyId, blueprintId).filter((i) => i.status === 'pending'),
    });
  }),
);

const optimizeChatSchema = z.object({ message: z.string().min(1).max(4000) });

blueprintOptimizationRouter.post(
  '/blueprints/:blueprintId/optimize-chat',
  asyncHandler(async (req, res) => {
    const companyId = param(req, 'id');
    const blueprintId = param(req, 'blueprintId');
    assertBlueprintCompany(blueprintId, companyId);
    const { message } = optimizeChatSchema.parse(req.body);
    res.json(await sendOptimizeChatMessage(getDb(), companyId, blueprintId, message));
  }),
);

blueprintOptimizationRouter.get(
  '/optimization-items',
  asyncHandler(async (req, res) => {
    const companyId = param(req, 'id');
    const blueprintId = typeof req.query.blueprintId === 'string' && req.query.blueprintId ? req.query.blueprintId : undefined;
    res.json(listOptimizationItems(getDb(), companyId, blueprintId));
  }),
);

function assertItemCompany(itemId: string, companyId: string): void {
  const row = getDb().prepare('SELECT company_id FROM blueprint_optimization_item WHERE id=?').get(itemId) as { company_id: string } | undefined;
  if (!row || row.company_id !== companyId) throw new AppError(ErrorCode.NOT_FOUND, '优化建议不存在');
}

blueprintOptimizationRouter.post(
  '/optimization-items/:itemId/apply',
  asyncHandler(async (req, res) => {
    assertItemCompany(param(req, 'itemId'), param(req, 'id'));
    res.json(applyOptimizationItem(getDb(), param(req, 'itemId')));
  }),
);

blueprintOptimizationRouter.post(
  '/optimization-items/:itemId/ignore',
  asyncHandler(async (req, res) => {
    assertItemCompany(param(req, 'itemId'), param(req, 'id'));
    ignoreOptimizationItem(getDb(), param(req, 'itemId'));
    res.status(204).end();
  }),
);
