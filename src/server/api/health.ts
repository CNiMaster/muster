/**
 * 健康检查路由。Phase 0 仅暴露 /api/health。
 */
import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'muster',
    version: '3.0.0',
    time: new Date().toISOString(),
  });
});
