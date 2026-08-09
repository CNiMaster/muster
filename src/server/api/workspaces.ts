import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { createWorkspace, getWorkspaceMigrationStatus, listWorkspaces, migrateWorkspace, setActiveWorkspace } from '../domain/workspace';
import { asyncHandler, param } from './middleware';

export const workspacesRouter = Router();

workspacesRouter.get('/', asyncHandler(async (_req, res) => {
  res.json(listWorkspaces(getDb()));
}));

workspacesRouter.post('/', asyncHandler(async (req, res) => {
  const input = z.object({ name: z.string().min(1), rootDir: z.string().min(1) }).parse(req.body);
  res.status(201).json(createWorkspace(getDb(), input));
}));

// 切换前的状态检查：旧目录存量项目数 + 目标目录是否非空 + 提示文案
workspacesRouter.get('/:id/migration-status', asyncHandler(async (req, res) => {
  res.json(getWorkspaceMigrationStatus(getDb(), param(req, 'id')));
}));

// 迁移整个工作区目录到新位置（连文件一起搬走，DB 前缀同步重映射）
workspacesRouter.post('/:id/migrate', asyncHandler(async (req, res) => {
  const input = z.object({ newRootDir: z.string().min(1) }).parse(req.body);
  res.json(migrateWorkspace(getDb(), param(req, 'id'), input.newRootDir));
}));

workspacesRouter.post('/:id/activate', asyncHandler(async (req, res) => {
  res.json(setActiveWorkspace(getDb(), param(req, 'id')));
}));
