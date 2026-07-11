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
import { projectArtifactsRouter } from './api/artifacts';
import { companyEventsRouter, projectEventsRouter } from './api/events';
import { workflowsRouter } from './api/workflows';
import { settingsRouter } from './api/settings';
import { departmentsRouter } from './api/departments';
import { setupAssistantRouter } from './api/setup-assistant';
import { workspacesRouter } from './api/workspaces';
import { agentProfilesRouter, companyEmployeesRouter } from './api/agent-profiles';
import { memoryRouter } from './api/memory';
import { permissionsRouter } from './api/permissions';
import { executorsRouter } from './api/executors';
import { CodexCliAdapter } from './executors/codex-cli-adapter';
import { GeminiCliAdapter } from './executors/gemini-cli-adapter';
import { bridgeRouter } from './bridge';
import { asyncHandler, errorMiddleware, param } from './api/middleware';
import { realtime } from './realtime';
import { getDb } from './db/client';
import { TaskEngine } from './task-engine/engine';
import { ClaudeCodeAdapter } from './executors/claude-code-adapter';
import { OpenAICompatibleAdapter } from './executors/openai-adapter';
import { GeminiAdapter } from './executors/gemini-adapter';
import { FakeExecutor } from './task-engine/fake-executor';
import { getSystemSettings } from './domain/setting';
import { TriggerScheduler } from './trigger-scheduler';
import { ProjectRuntimeCoordinator } from './runtime/coordinator';
import { listAgentProfiles } from './domain/agent-profile';
import { materializeAgentHome, syncAgentMemoryFiles } from './domain/agent-home';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AppHandle {
  app: express.Express;
  engine: TaskEngine;
  triggerScheduler: TriggerScheduler;
  coordinator: ProjectRuntimeCoordinator;
}

async function createApp(): Promise<AppHandle> {
  // 确保 ~/.muster 存在
  mkdirSync(SERVER_CONFIG.musterDir, { recursive: true });

  const app = express();
  app.use(express.json({ limit: '8mb' }));

  // 初始化数据库（应用 migration）
  const db = getDb();
  for (const profile of listAgentProfiles(db)) {
    materializeAgentHome(profile);
    syncAgentMemoryFiles(db, profile.id);
  }

  // ===== /api/projects/:id 子树统一挂载 =====
  // 把所有 project 范围内的子路由挂到 projectById 下，避免多个 Router 并列在前缀上导致顺序冲突。
  projectById.use('/tasks', taskByProjectRouter);
  projectById.use('/usage', usageRouter);
  projectById.use('/messages', projectMessagesRouter);
  projectById.use('/events', projectEventsRouter);
  projectById.use('/artifacts', projectArtifactsRouter);
  projectById.use('/', projectScopedNovel);   // chapter-completed / correction / check
  projectById.use('/', projectPhase7);         // reports / inspector / brainstorm

  // 手动 pump 端点（dev/测试用；正常由引擎轮询驱动）
  projectById.post(
    '/pump',
    asyncHandler(async (req, res) => {
      const result = await coordinator.pumpProject(param(req, 'id'));
      res.json(result);
    }),
  );

  // 创建 Task 引擎实例（先于 API 引用）
  // Batch 10/12/13：多 provider adapter 注册表。
  // Fake 模式下所有 provider 都用 FakeExecutor；
  // 真实模式下 claude-cli 用 ClaudeCodeAdapter，openai/gemini 用对应 adapter。
  const isFake = process.env.MUSTER_EXECUTOR === 'fake';
  const adapterRegistry = new Map<string, import('./task-engine/executor').ExecutionAdapter>();
  if (isFake) {
    const fake = new FakeExecutor();
    adapterRegistry.set('claude-cli', fake);
    adapterRegistry.set('openai', fake);
    adapterRegistry.set('gemini', fake);
    adapterRegistry.set('codex-cli', fake);
    adapterRegistry.set('gemini-cli', fake);
    adapterRegistry.set('custom-cli', fake);
  } else {
    adapterRegistry.set('claude-cli', new ClaudeCodeAdapter());
    adapterRegistry.set('openai', new OpenAICompatibleAdapter());
    adapterRegistry.set('gemini', new GeminiAdapter());
    adapterRegistry.set('codex-cli', new CodexCliAdapter());
    adapterRegistry.set('gemini-cli', new GeminiCliAdapter());
  }
  const engine = new TaskEngine(getDb(), adapterRegistry, {
    pollIntervalMs: Number(process.env.MUSTER_POLL_INTERVAL_MS ?? 2000),
    concurrency: Number(process.env.MUSTER_CONCURRENCY ?? 4),
  });
  // 应用系统默认 provider
  const sysSettings = getSystemSettings(getDb());
  engine.setDefaultProvider(sysSettings.defaultProvider);
  const triggerScheduler = new TriggerScheduler(
    getDb(),
    Number(process.env.MUSTER_TRIGGER_POLL_INTERVAL_MS ?? 1000),
  );
  const coordinator = new ProjectRuntimeCoordinator(
    getDb(),
    engine,
    Number(process.env.MUSTER_POLL_INTERVAL_MS ?? 2000),
  );
  // API（顶层）
  app.use('/api', healthRouter);
  app.use('/api/companies', companiesRouter);
  app.use('/api/novel', novelRouter);
  app.use('/api/companies/:companyId/agents', agentsRouter);
  app.use('/api/companies/:companyId/employees', companyEmployeesRouter);
  app.use('/api/companies/:companyId/departments', departmentsRouter);
  app.use('/api/companies/:companyId/projects', projectsRouter);
  app.use('/api/companies/:companyId/relationships', graphsRouter);
  app.use('/api/companies/:companyId/workflows', workflowsRouter);
  app.use('/api/companies/:id/messages', companyMessagesRouter);
  app.use('/api/companies/:companyId/events', companyEventsRouter);
  app.use('/api/projects/:id', projectById);
  app.use('/api/reports/:id', reportByIdRouter);
  app.use('/api/tasks/:id', taskByIdRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/workspaces', workspacesRouter);
  app.use('/api/agent-profiles', agentProfilesRouter);
  app.use('/api/agent-profiles/:profileId/memory', memoryRouter);
  app.use('/api/permissions', permissionsRouter);
  app.use('/api/executors', executorsRouter);
  app.use('/api/setup-assistant', setupAssistantRouter);

  // Agent Bridge：Agent 通过 curl 调用 /bridge/<action> 反馈进度
  app.use('/bridge', bridgeRouter);

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

  return { app, engine, triggerScheduler, coordinator };
}

async function main(): Promise<void> {
  const { app, engine, triggerScheduler, coordinator } = await createApp();
  const httpServer = createServer(app);

  // Agent Bridge loopback 端口注入
  engine.serverPort = SERVER_CONFIG.port;

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  realtime.attach(wss);

  // 启动 Task 引擎轮询
  coordinator.start();
  triggerScheduler.start();

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
    coordinator.stop();
    triggerScheduler.stop();
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
