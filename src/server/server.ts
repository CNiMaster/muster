/**
 * Muster 服务入口。
 *
 * 单端口 3456：
 * - 开发：Express + Vite middleware（前端热更新）
 * - 生产：Express 服务 dist/client 构建产物
 *
 * 引擎在 server 启动时 start()，定时轮询所有 online 公司的活跃线程。
 * /api/projects/:id 子树统一在 projectById Router 下挂载，避免路由顺序冲突。
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
import { taskByProjectRouter, taskByIdRouter } from './api/tasks';
import { usageRouter } from './api/reports-usage';
import { novelRouter, projectScopedNovel } from './api/novel';
import { projectPhase7, reportByIdRouter } from './api/phase7';
import { companyMessagesRouter, projectMessagesRouter } from './api/conversation';
import { asyncHandler, errorMiddleware, param } from './api/middleware';
import { realtime } from './realtime';
import { getDb } from './db/client';
import { TaskEngine } from './task-engine/engine';
import { ClaudeCodeAdapter } from './executors/claude-code-adapter';
import { getProject } from './domain/project';
import { listThreads } from './domain/thread';
import { AppError, ErrorCode } from '../shared/errors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AppHandle {
  app: express.Express;
  engine: TaskEngine;
}

async function createApp(): Promise<AppHandle> {
  // 确保 ~/.muster 存在
  mkdirSync(SERVER_CONFIG.musterDir, { recursive: true });

  const app = express();
  app.use(express.json({ limit: '8mb' }));

  // 初始化数据库（应用 migration）
  getDb();

  // ===== /api/projects/:id 子树统一挂载 =====
  // 把所有 project 范围内的子路由挂到 projectById 下，避免多个 Router 并列在前缀上导致顺序冲突。
  projectById.use('/tasks', taskByProjectRouter);
  projectById.use('/usage', usageRouter);
  projectById.use('/messages', projectMessagesRouter);
  projectById.use('/', projectScopedNovel);   // chapter-completed / correction / check
  projectById.use('/', projectPhase7);         // reports / inspector / brainstorm

  // 手动 pump 端点（dev/测试用；正常由引擎轮询驱动）
  projectById.post(
    '/pump',
    asyncHandler(async (req, res) => {
      const threads = listThreads(getDb(), param(req, 'id'));
      if (threads.length === 0) throw new AppError(ErrorCode.NOT_FOUND, '项目无活跃线程');
      const ran = await engine.pumpAll(threads.map((t) => t.id));
      res.json({ pumped: ran, totalThreads: threads.length });
    }),
  );

  // 创建 Task 引擎实例（先于 API 引用）
  const adapter = new ClaudeCodeAdapter();
  const engine = new TaskEngine(getDb(), adapter, {
    pollIntervalMs: Number(process.env.MUSTER_POLL_INTERVAL_MS ?? 2000),
    concurrency: Number(process.env.MUSTER_CONCURRENCY ?? 4),
  });

  // API（顶层）
  app.use('/api', healthRouter);
  app.use('/api/companies', companiesRouter);
  app.use('/api/novel', novelRouter);
  app.use('/api/companies/:companyId/agents', agentsRouter);
  app.use('/api/companies/:companyId/projects', projectsRouter);
  app.use('/api/companies/:companyId/relationships', graphsRouter);
  app.use('/api/companies/:id/messages', companyMessagesRouter);
  app.use('/api/projects/:id', projectById);
  app.use('/api/reports/:id', reportByIdRouter);
  app.use('/api/tasks/:id', taskByIdRouter);

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

  return { app, engine };
}

async function main(): Promise<void> {
  const { app, engine } = await createApp();
  const httpServer = createServer(app);

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  realtime.attach(wss);

  // 启动 Task 引擎轮询
  engine.start();

  httpServer.listen(SERVER_CONFIG.port, SERVER_CONFIG.host, () => {
    log.info('muster server listening', {
      host: SERVER_CONFIG.host,
      port: SERVER_CONFIG.port,
      mode: SERVER_CONFIG.isProd ? 'prod' : 'dev',
    });
  });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    engine.stop();
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

// 兼容测试导入（createApp 仍可被引用）
export { createApp };
void getProject;
