/**
 * Reports + Usage REST 路由。
 - GET /api/projects/:id/usage           项目用量聚合
 - GET /api/projects/:id/agents/:aid/usage  根员工用量聚合
 - GET /api/projects/:id/reports          复盘列表
 */
import { Router } from 'express';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { summarizeProjectUsage, summarizeAgentUsage } from '../domain/usage';

export const usageRouter = Router({ mergeParams: true });

usageRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(summarizeProjectUsage(getDb(), param(req, 'id')));
  }),
);

usageRouter.get(
  '/agents/:agentId',
  asyncHandler(async (req, res) => {
    res.json(summarizeAgentUsage(getDb(), param(req, 'id'), param(req, 'agentId')));
  }),
);
