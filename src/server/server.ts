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
import { startGracefulShutdownSequence } from './runtime/shutdown';
import { healthRouter } from './api/health';
import { agentsRouter } from './api/agents';
import { projectsRouter, projectById, quickProjectsRouter } from './api/projects';
import { playbooksRouter } from './api/projects';
import { graphsRouter } from './api/graphs';
import { taskByProjectRouter, taskByIdRouter } from './api/tasks';
import { usageRouter } from './api/reports-usage';
import { novelRouter, projectScopedNovel } from './api/novel';
import { blueprintOptimizationRouter } from './api/blueprint-optimization';
import { blueprintsRouter } from './api/blueprints';
import { expertCandidatesRouter } from './api/expert-candidates';
import { projectPhase7, reportByIdRouter, inspectorAlertRouter } from './api/phase7';
import { companyMessagesRouter, projectMessagesRouter } from './api/conversation';
import { pluginsRouter } from './api/plugins';
import { outsourcingRouter } from './api/outsourcing';
import { tempWorkerRouter } from './api/temp-worker';
import { delegationRouter } from './api/permission-delegation';
import { handoverRouter } from './api/handover';
import { projectArtifactsRouter } from './api/artifacts';
import { companyEventsRouter, projectEventsRouter } from './api/events';
import { workflowsRouter } from './api/workflows';
import { settingsRouter } from './api/settings';
import { departmentsRouter } from './api/departments';
import { setupAssistantRouter } from './api/setup-assistant';
import { workspacesRouter } from './api/workspaces';
import { workbenchRouter } from './api/workbench';
import { recoverInterruptedMigrations } from './domain/workspace';
import { startExecutorHealthSweeps } from './domain/executor-failover';
import { agentProfilesRouter, companyEmployeesRouter } from './api/agent-profiles';
import { canvasLayoutsRouter } from './api/canvas-layouts';
import { memoryRouter } from './api/memory';
import { permissionsRouter } from './api/permissions';
import { discussionsRouter } from './api/discussions';
import { executorsRouter } from './api/executors';
import { CodexCliAdapter } from './executors/codex-cli-adapter';
import { AntigravityCliAdapter } from './executors/antigravity-cli-adapter';
import { OpenCodeCliAdapter } from './executors/opencode-cli-adapter';
import { CustomCliAdapter } from './executors/custom-cli-adapter';
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
import { applyGlobalEgress, buildEgressEnv } from './runtime/egress';
import { TriggerScheduler } from './trigger-scheduler';
import { ProjectRuntimeCoordinator } from './runtime/coordinator';
import { listAgentProfiles } from './domain/agent-profile';
import { materializeAgentHome, syncAgentMemoryFiles } from './domain/agent-home';
import { autoDiscoverCertifiedExecutors } from './domain/executor-discovery';
import { syncToolRegistry } from './domain/tool-registry';
import { seedDefaultCredentialDefinitions } from './domain/credential-store';
import { toolsRouter } from './api/tools';
import { credentialsRouter } from './api/credentials';
import { materialsRouter } from './api/materials';
import { businessReviewsRouter } from './api/business-reviews';
import { backupRouter } from './api/backup';
import { setupRouter } from './api/setup';
import { ensureWorkbench, updateWorkbench, DEFAULT_WORKBENCH_NAME } from './domain/workbench';

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
  if(process.env.MUSTER_AUTO_EXECUTOR_DISCOVERY!=='false')queueMicrotask(()=>{void autoDiscoverCertifiedExecutors(db);});
  for (const profile of listAgentProfiles(db)) {
    materializeAgentHome(profile);
    syncAgentMemoryFiles(db, profile.id);
  }
  // Review 修复（M-6）：启动自愈——若上次 workspace 迁移在文件移动后、DB 提交前中断，
  // 依据 migrating 标记补提路径更新，避免「文件在新目录、DB 指向旧路径」的孤儿状态。
  recoverInterruptedMigrations(db);
  // 故障转移巡检：启动 + 每 10 分钟，不健康执行器档案验活/冷却放回（executor-failover）
  startExecutorHealthSweeps(() => db);

  // ===== /api/projects/:id 子树统一挂载 =====
  // 把所有 project 范围内的子路由挂到 projectById 下，避免多个 Router 并列在前缀上导致顺序冲突。
  projectById.use('/tasks', taskByProjectRouter);
  projectById.use('/usage', usageRouter);
  projectById.use('/messages', projectMessagesRouter);
  projectById.use('/events', projectEventsRouter);
  projectById.use('/artifacts', projectArtifactsRouter);
  projectById.use('/discussions', discussionsRouter);
  projectById.use('/materials', materialsRouter);
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
    adapterRegistry.set('antigravity-cli', fake);
    adapterRegistry.set('opencode-cli', fake);
    adapterRegistry.set('custom-cli', fake);
  } else {
    adapterRegistry.set('claude-cli', new ClaudeCodeAdapter());
    adapterRegistry.set('openai', new OpenAICompatibleAdapter());
    adapterRegistry.set('gemini', new GeminiAdapter());
    adapterRegistry.set('codex-cli', new CodexCliAdapter());
    adapterRegistry.set('antigravity-cli', new AntigravityCliAdapter());
    adapterRegistry.set('opencode-cli', new OpenCodeCliAdapter());
    adapterRegistry.set('custom-cli', new CustomCliAdapter());
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
  // 启动时扫描 tools/ 目录入索引(能力中心基础设施)
  try {
    const toolSync = syncToolRegistry(getDb());
    if (toolSync.added || toolSync.updated || toolSync.removed) {
      log.info('tool registry synced', toolSync);
    }
  } catch (err) {
    log.warn('tool registry sync failed', { error: err instanceof Error ? err.message : String(err) });
  }
  // 启动时 seed 默认凭据定义(平台级基本能力,幂等)
  try {
    const credSeed = seedDefaultCredentialDefinitions(getDb());
    if (credSeed.added) {
      log.info('default credentials seeded', credSeed);
    }
  } catch (err) {
    log.warn('credential seed failed', { error: err instanceof Error ? err.message : String(err) });
  }
  // 公司退役批次A：启动确保默认工作台单例（无则建「默认工作台」；未用默认名则更名，幂等）
  try {
    const ensured = ensureWorkbench(getDb());
    if (ensured.created) {
      log.info('default workbench created', { id: ensured.workbench.id });
    } else if (ensured.workbench.name !== DEFAULT_WORKBENCH_NAME) {
      updateWorkbench(getDb(), { name: DEFAULT_WORKBENCH_NAME });
      log.info('default workbench renamed', { from: ensured.workbench.name });
    }
  } catch (err) {
    log.warn('default workbench ensure failed', { error: err instanceof Error ? err.message : String(err) });
  }
  // API（顶层）
  app.use('/api', healthRouter);
  app.use('/api/novel', novelRouter);
  // 公司退役批次C：旧 /api/companies/:companyId/* 挂载已全部下线（新路径见下；handler 经 companyIdOf 解析默认工作台）
  app.use('/api/workbench', workbenchRouter);
  app.use('/api/blueprints', blueprintsRouter);
  app.use('/api/blueprint-optimization', blueprintOptimizationRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/employees', companyEmployeesRouter);
  app.use('/api/departments', departmentsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/relationships', graphsRouter);
  app.use('/api/workflows', workflowsRouter);
  app.use('/api/messages', companyMessagesRouter);
  app.use('/api/events', companyEventsRouter);
  app.use('/api/expert-candidates', expertCandidatesRouter);
  app.use('/api/playbooks', playbooksRouter);
  // 蓝图组织批次4c：项目优先入口（须在 /api/projects/:id 之前挂载，避免被 :id 参数吞掉）
  app.use('/api/projects/quick', quickProjectsRouter);
  app.use('/api/projects/:id', projectById);
  app.use('/api/plugins', pluginsRouter);
  app.use('/api', outsourcingRouter);
  app.use('/api', tempWorkerRouter);
  app.use('/api', delegationRouter);
  app.use('/api', handoverRouter);
  app.use('/api/reports/:id', reportByIdRouter);
  app.use('/api/inspector/alerts', inspectorAlertRouter);
  app.use('/api/tasks/:id', taskByIdRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/workspaces', workspacesRouter);
  app.use('/api/agent-profiles', agentProfilesRouter);
  app.use('/api/agent-profiles/:profileId/memory', memoryRouter);
  app.use('/api/canvas-layouts', canvasLayoutsRouter);
  app.use('/api/permissions', permissionsRouter);
  app.use('/api/executors', executorsRouter);
  app.use('/api/setup-assistant', setupAssistantRouter);
  app.use('/api/tools', toolsRouter);
  app.use('/api/credentials', credentialsRouter);
  app.use('/api/business-reviews', businessReviewsRouter);
  app.use('/api/backup', backupRouter);
  app.use('/api/setup', setupRouter);

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
  // spec 2026-08-12-settings-overhaul B1：出口网络统一配置（代理/例外/证书），启动时一次性生效。
  // 设置变更需重启：dispatcher 在进程启动时全局设置；NODE_EXTRA_CA_CERTS 供 CLI/MCP/命令工具子进程继承。
  {
    const sysSettings = getSystemSettings(getDb());
    applyGlobalEgress({
      proxyUrl: sysSettings.proxyUrl,
      proxyBypass: sysSettings.proxyBypass,
      caCertPath: sysSettings.caCertPath,
    });
    const egressEnv = buildEgressEnv({ caCertPath: sysSettings.caCertPath });
    if (egressEnv.NODE_EXTRA_CA_CERTS) process.env.NODE_EXTRA_CA_CERTS = egressEnv.NODE_EXTRA_CA_CERTS;
    log.info('egress configured', {
      proxy: sysSettings.proxyUrl ? 'configured' : 'direct',
      caCert: sysSettings.caCertPath ? 'configured' : 'none',
    });
  }

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

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    // L1：第二次信号 = 用户等不及，强制退出。engine.stop() 会把在跑任务退回 queued
    // （任务持久化，下次启动重跑），因此强退安全——不会像旧版把 AbortError 判成永久失败。
    if (shuttingDown) {
      log.warn('shutdown already in progress — forcing exit', { signal });
      engine.stop();
      coordinator.stop();
      triggerScheduler.stop();
      httpServer.close();
      wss.close();
      setTimeout(() => process.exit(0), 300);
      return;
    }
    shuttingDown = true;
    log.info('shutting down (graceful)', { signal });
    // L1：优雅关机——先让所有 online 公司排空下班（coordinator 继续 tick 收尾），
    // 全部完成后停止引擎并退出；超时兜底 60s（任务持久化，下次启动恢复）。
    startGracefulShutdownSequence({
      onComplete: () => {
        engine.stop();
        coordinator.stop();
        triggerScheduler.stop();
        httpServer.close();
        wss.close();
        setTimeout(() => process.exit(0), 500);
      },
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 全局兜底：避免未被 await 的 rejected promise（如 watchdog 竞态）或 Express 之外的
  // 未捕获异常直接杀掉 dev 服务进程——这正是「动态 import failed / 服务器突然关闭」的
  // 典型根因。这里只记录日志、不退出，让单次异常不要拖垮整个平台。
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection (suppressed, process kept alive)', {
      error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
    });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException (suppressed, process kept alive)', {
      error: `${err.name}: ${err.message}`,
      stack: err.stack,
    });
  });
}

main().catch((err) => {
  log.error('fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

// 兼容测试导入（createApp 仍可被引用）
export { createApp };
