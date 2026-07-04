/**
 * Muster 服务入口。
 *
 * 单端口 3456：
 * - 开发：Express + Vite middleware（前端热更新）
 * - 生产：Express 服务 dist/client 构建产物
 *
 * Phase 0：仅 /api/health + 静态壳页面。后续 phase 在此挂载领域路由。
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_CONFIG } from './env';
import { log } from './logger';
import { healthRouter } from './api/health';
import { companiesRouter } from './api/companies';
import { agentsRouter } from './api/agents';
import { projectsRouter, projectById } from './api/projects';
import { graphsRouter } from './api/graphs';
import { errorMiddleware } from './api/middleware';
import { realtime } from './realtime';
import { getDb } from './db/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function createApp(): Promise<express.Express> {
  // 确保 ~/.muster 存在
  mkdirSync(SERVER_CONFIG.musterDir, { recursive: true });

  const app = express();
  app.use(express.json({ limit: '8mb' }));

  // 初始化数据库（应用 migration）
  getDb();

  // API
  app.use('/api', healthRouter);
  app.use('/api/companies', companiesRouter);
  app.use('/api/companies/:companyId/agents', agentsRouter);
  app.use('/api/companies/:companyId/projects', projectsRouter);
  app.use('/api/companies/:companyId/relationships', graphsRouter);
  app.use('/api/projects/:id', projectById);

  app.use(errorMiddleware);

  // 静态前端
  if (SERVER_CONFIG.isProd) {
    const clientDist = path.resolve(__dirname, '../client');
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else {
    // 开发模式：挂载 Vite middleware
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({
      root: path.resolve(__dirname, '../../src/client'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  return app;
}

async function main(): Promise<void> {
  const app = await createApp();
  const httpServer = createServer(app);

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  realtime.attach(wss);

  httpServer.listen(SERVER_CONFIG.port, SERVER_CONFIG.host, () => {
    log.info('muster server listening', {
      host: SERVER_CONFIG.host,
      port: SERVER_CONFIG.port,
      mode: SERVER_CONFIG.isProd ? 'prod' : 'dev',
    });
  });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    httpServer.close();
    wss.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
