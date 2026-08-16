/**
 * 蓝图深度优化 API（挂在 /api/companies/:id/blueprints/optimize 等）。
 * - POST /optimize          按需生成建议（LLM，失败降级规则引擎）
 * - GET  /optimization-items 列出建议
 * - POST /optimization-items/:itemId/apply    采纳（版本化落地）
 * - POST /optimization-items/:itemId/ignore   忽略
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { generateBlueprintOptimization, listOptimizationItems, applyOptimizationItem, ignoreOptimizationItem } from '../domain/blueprint-optimizer';
import { AppError, ErrorCode } from '../../shared/errors';
import { ClaudeSetupGenerator } from '../domain/setup-assistant';
import { asyncHandler, param } from './middleware';

export const blueprintOptimizationRouter = Router({ mergeParams: true });

blueprintOptimizationRouter.post(
  '/optimize',
  asyncHandler(async (req, res) => {
    res.json(await generateBlueprintOptimization(getDb(), param(req, 'id'), { generator: new ClaudeSetupGenerator(getDb()) }));
  }),
);

blueprintOptimizationRouter.get(
  '/optimization-items',
  asyncHandler(async (req, res) => {
    res.json(listOptimizationItems(getDb(), param(req, 'id')));
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

void z;
