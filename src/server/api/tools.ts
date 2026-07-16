/**
 * 工具档案管理 API。
 * GET    /api/tools            列出工具档案(支持 capability/implementation/active 筛选)
 * GET    /api/tools/:id        工具档案详情
 * GET    /api/tools/:id/content 工具档案全文(预览)
 * PUT    /api/tools/defaults   后台设置默认派发项
 * PUT    /api/tools/:id        后台调整单个工具(活跃/默认)
 * POST   /api/tools/sync       手动重新扫描 tools/ 目录
 */
import { Router } from 'express';
import { getDb } from '../db/client';
import {
  getTool,
  listTools,
  readToolContent,
  setDefaultTools,
  setToolActive,
  setToolDefault,
  syncToolRegistry,
} from '../domain/tool-registry';
import { AppError, ErrorCode } from '../../shared/errors';
import { asyncHandler, param } from './middleware';

export const toolsRouter = Router();

toolsRouter.get('/', asyncHandler(async (req, res) => {
  const capabilityId = typeof req.query.capability === 'string' ? req.query.capability : undefined;
  const implementation = typeof req.query.implementation === 'string' ? (req.query.implementation as 'local' | 'api') : undefined;
  const activeOnly = req.query.active === '1' || req.query.active === 'true';
  res.json(listTools(getDb(), { capabilityId, implementation, activeOnly }));
}));

toolsRouter.get('/sync', asyncHandler(async (_req, res) => {
  res.json(syncToolRegistry(getDb()));
}));

toolsRouter.put('/defaults', asyncHandler(async (req, res) => {
  const toolIds = Array.isArray(req.body?.toolIds) ? req.body.toolIds.filter((v: unknown): v is string => typeof v === 'string') : [];
  setDefaultTools(getDb(), toolIds);
  res.json({ ok: true });
}));

toolsRouter.get('/:id', asyncHandler(async (req, res) => {
  const tool = getTool(getDb(), param(req, 'id'));
  if (!tool) throw new AppError(ErrorCode.NOT_FOUND, '工具档案不存在');
  res.json(tool);
}));

toolsRouter.get('/:id/content', asyncHandler(async (req, res) => {
  const content = readToolContent(getDb(), param(req, 'id'));
  if (content === null) throw new AppError(ErrorCode.NOT_FOUND, '工具档案不存在');
  res.json({ content });
}));

toolsRouter.put('/:id', asyncHandler(async (req, res) => {
  const id = param(req, 'id');
  const tool = getTool(getDb(), id);
  if (!tool) throw new AppError(ErrorCode.NOT_FOUND, '工具档案不存在');
  if (typeof req.body?.isActive === 'boolean') {
    setToolActive(getDb(), id, req.body.isActive);
  }
  if (typeof req.body?.isDefault === 'boolean') {
    setToolDefault(getDb(), id, req.body.isDefault);
  }
  res.json(getTool(getDb(), id));
}));
