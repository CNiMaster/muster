/**
 * 项目素材区 API(挂在 /api/projects/:projectId/materials)。
 * GET    /           列表(支持 kind/tag 筛选)
 * POST   /           导入(body: mode=link|moved|copied + sourcePath/sourceUrl)
 * DELETE /:id        删除素材(moved/copied 型连同文件删除)
 * PUT    /:id        更新名称/标签
 * GET    /health     素材健康检查(link 型源文件是否存在)
 */
import { Router } from 'express';
import { getDb } from '../db/client';
import { importMaterial, listMaterials, deleteMaterial, updateMaterial, checkMaterialHealth, type MaterialKind } from '../domain/material';
import { AppError, ErrorCode } from '../../shared/errors';
import { asyncHandler, param } from './middleware';

export const materialsRouter = Router({ mergeParams: true });

materialsRouter.get('/', asyncHandler(async (req, res) => {
  const projectId = param(req, 'projectId');
  const kind = typeof req.query.kind === 'string' ? (req.query.kind as MaterialKind) : undefined;
  const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
  res.json(listMaterials(getDb(), projectId, { kind, tag }));
}));

materialsRouter.get('/health', asyncHandler(async (req, res) => {
  res.json(checkMaterialHealth(getDb(), param(req, 'projectId')));
}));

materialsRouter.post('/', asyncHandler(async (req, res) => {
  const projectId = param(req, 'projectId');
  const { mode, sourcePath, sourceUrl, name, tags, createdBy } = req.body ?? {};
  if (mode !== 'link' && mode !== 'moved' && mode !== 'copied') {
    throw new AppError(ErrorCode.VALIDATION, 'mode 必须是 link/moved/copied');
  }
  res.status(201).json(importMaterial(getDb(), projectId, { mode, sourcePath, sourceUrl, name, tags, createdBy }));
}));

materialsRouter.delete('/:id', asyncHandler(async (req, res) => {
  deleteMaterial(getDb(), param(req, 'id'));
  res.status(204).end();
}));

materialsRouter.put('/:id', asyncHandler(async (req, res) => {
  const { name, tags } = req.body ?? {};
  res.json(updateMaterial(getDb(), param(req, 'id'), {
    name: typeof name === 'string' ? name : undefined,
    tags: Array.isArray(tags) ? tags.filter((t: unknown): t is string => typeof t === 'string') : undefined,
  }));
}));
