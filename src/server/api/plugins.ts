/**
 * Plugin REST 路由（B3a + opt-out 治理）。
 *
 * 通用能力接入 API：用户通过这些路由安装任意 MCP server / skill / tool 配置，
 * 并按公司级启停。系统不关心具体是哪个能力，只做 CRUD + 启停 + 连接测试。
 *
 * opt-out 语义（20260809100000 迁移后）：
 *   - 平台级插件默认对所有公司启用，公司可显式禁用
 *   - 公司独占插件（scope=company）仅对目标公司可见
 *
 * - GET    /api/plugins                                列出（含 builtin 只读视图）
 * - GET    /api/plugins/:id                            单个详情
 * - POST   /api/plugins                                安装（写 plugin 表）
 * - DELETE /api/plugins/:id                            移除
 * - POST   /api/plugins/:id/test                       测试 MCP server 连接
 * - POST   /api/plugins/:id/enable   撤销禁用（恢复平台默认）
 * - POST   /api/plugins/:id/disable  显式禁用某平台插件
 * - GET    /api/plugins/effective   工作台实际生效的插件（含三态）
 * - GET    /api/plugins/enabled     工作台生效 plugin id 列表
 * - GET    /api/plugins/company-scoped/:companyId        公司独占插件列表
 * - POST   /api/plugins/exclusive   安装工作台独占插件
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, companyIdOf } from './middleware';
import { getDb } from '../db/client';
import { listPlugins, getPlugin } from '../domain/plugin-adapter';
import { recheckCapabilityBlocked } from '../domain/automation';
import { panelManifestSchema } from '../domain/panel-plugin';
import {
  installPlugin,
  removePlugin,
  setCompanyPluginDecision,
  getCompanyPluginDecisions,
  getEffectivePluginsForCompany,
  listEnabledCompanyPlugins,
  getPluginRow,
} from '../domain/plugin-install';
import { McpClientPool } from '../executors/tools/mcp/client-pool';
import { searchMarketplace, installMarketplaceEntry, type MarketplaceEntry, type InstallScope } from '../domain/marketplace';
import { listMarketplacePresets, installPreset } from '../domain/marketplace-presets';
import { searchMarketplaceCatalog } from '../domain/marketplace-search';
import { listMarketplaceSources, addMarketplaceSource } from '../domain/marketplace-sources';
import { installClaudeCodePlugin } from '../domain/marketplace-claude-plugins';
import { authorSkill } from '../domain/skill-author';
import { getWorkbench, isOrgLocked} from '../domain/workbench';
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';
import { AppError, ErrorCode } from '../../shared/errors';

/** 组织配置锁：启停 plugin 需工作台下班。 */
function assertWorkbenchOff(db: ReturnType<typeof getDb>): void {
  const wb = getWorkbench(db);
  if (isOrgLocked(db)) { /* 2026-08-23 上下班退役：插件启停只在任务执行中锁 */
    throw new AppError(ErrorCode.COMPANY_LOCKED, '工作台上班期间不能修改能力配置，请先让工作台下班');
  }
}

export const pluginsRouter = Router();

pluginsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(listPlugins(getDb()));
  }),
);

// 工作台级插件启停/生效视图
// 注意：本段必须注册在 GET /:id 之前，否则 /effective 等字面路径会被 /:id 吞掉。
const companyEnableHandler = asyncHandler(async (req, res) => {
  assertWorkbenchOff(getDb());
  // opt-out：enable = 撤销禁用，恢复平台默认全开
  setCompanyPluginDecision(getDb(), param(req, 'id'), 'enabled');
  realtime.publish(makeLifecycleEvent('plugin.enabled', { pluginId: param(req, 'id') }, {}));
  recheckCapabilityBlocked(getDb()); // 能力齐了 → 自动恢复被挂起的自动化
  res.json({ ok: true });
});
pluginsRouter.post('/:id/enable', companyEnableHandler);

const companyDisableHandler = asyncHandler(async (req, res) => {
  assertWorkbenchOff(getDb());
  // opt-out：disable = 显式禁用某平台插件
  setCompanyPluginDecision(getDb(), param(req, 'id'), 'disabled');
  realtime.publish(makeLifecycleEvent('plugin.disabled', { pluginId: param(req, 'id') }, {}));
  recheckCapabilityBlocked(getDb()); // 禁用联动 → 依赖它的自动化重新对账挂起
  res.json({ ok: true });
});
pluginsRouter.post('/:id/disable', companyDisableHandler);

// 工作台实际生效的插件（opt-out：平台默认 - 禁用 + 工作台独占），含三态决策标注
const companyEffectiveHandler = asyncHandler(async (_req, res) => {
  const db = getDb();
  const effective = getEffectivePluginsForCompany(db);
  const decisions = getCompanyPluginDecisions(db);
  // 为每个插件标注工作台对其的三态决策：default（平台默认全开）/ enabled（显式启用痕迹）/ disabled（显式禁用）/ exclusive（工作台独占）
  const annotated = effective.map((p) => {
    let companyDecision: 'default' | 'enabled' | 'disabled' | 'exclusive';
    if (p.scope.level === 'workbench') {
      companyDecision = 'exclusive';
    } else {
      companyDecision = (decisions.get(p.id) as 'enabled' | 'disabled' | undefined) ?? 'default';
    }
    return { ...p, companyDecision };
  });
  res.json(annotated);
});
pluginsRouter.get('/effective', companyEffectiveHandler);

const companyEnabledHandler = asyncHandler(async (_req, res) => {
  // opt-out 迁移后语义=effective，保留旧路由名兼容历史调用方
  res.json(listEnabledCompanyPlugins(getDb()));
});
pluginsRouter.get('/enabled', companyEnabledHandler);

// 工作台独占插件列表（scope=workbench）
const companyScopedHandler = asyncHandler(async (_req, res) => {
  res.json(listPlugins(getDb(), { scopeLevel: 'workbench' }));
});
pluginsRouter.get('/company-scoped', companyScopedHandler);

// 安装工作台独占插件（scope=company，对工作台可见可用）
const exclusiveInstallSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  kind: z.enum(['skill', 'mcp-server', 'tool', 'bridge-action', 'ai-generated', 'panel', 'hook']),
  source: z.unknown(),
  manifest: z.record(z.unknown()),
  permissions: z.array(z.string()).optional(),
  credentialKeys: z.array(z.string()).optional(),
  maturity: z.enum(['experimental', 'stable', 'deprecated']).optional(),
});
const companyExclusiveHandler = asyncHandler(async (req, res) => {
  assertWorkbenchOff(getDb());
  const parsed = exclusiveInstallSchema.parse(req.body);
  // I-a：panel 插件 manifest 强校验（entry 相对 html 路径）——失败 400
  if (parsed.kind === 'panel') {
    const r = panelManifestSchema.safeParse(parsed.manifest.panel);
    if (!r.success) {
      res.status(400).json({ error: { code: 'validation', message: r.error.issues.map((i) => i.message).join('; ') } });
      return;
    }
  }
  const plugin = installPlugin(getDb(), {
    ...parsed,
    source: parsed.source as import('../../shared/plugin').PluginSource,
    // 强制 scope 为工作台独占
    scope: { level: 'workbench' },
    manifest: parsed.manifest as import('../../shared/plugin').Plugin['manifest'],
  });
  realtime.publish(makeLifecycleEvent('plugin.installed', { pluginId: plugin.id }, {}));
    recheckCapabilityBlocked(getDb()); // 安装即恢复被挂起的自动化（能力对账）
  res.status(201).json(plugin);
});
pluginsRouter.post('/exclusive', companyExclusiveHandler);

pluginsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const p = getPlugin(getDb(), param(req, 'id'));
    if (!p) throw new AppError(ErrorCode.NOT_FOUND, `plugin ${param(req, 'id')} 不存在`);
    res.json(p);
  }),
);

const installSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  kind: z.enum(['skill', 'mcp-server', 'tool', 'bridge-action', 'ai-generated', 'panel', 'hook']),
  // source/scope 用 passthrough 接收任意结构，运行时由 installPlugin 的 toSourceKind/Ref 容错；
  // 此处用 unknown 转换避免 zod 判别联合与 TS PluginSource 的窄化冲突。
  source: z.unknown(),
  scope: z.unknown(),
  manifest: z.record(z.unknown()),
  permissions: z.array(z.string()).optional(),
  credentialKeys: z.array(z.string()).optional(),
  maturity: z.enum(['experimental', 'stable', 'deprecated']).optional(),
});

pluginsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = installSchema.parse(req.body);
    if (parsed.kind === 'panel') {
      const r = panelManifestSchema.safeParse(parsed.manifest.panel);
      if (!r.success) {
        res.status(400).json({ error: { code: 'validation', message: r.error.issues.map((i) => i.message).join('; ') } });
        return;
      }
    }
    const input = {
      ...parsed,
      source: parsed.source as import('../../shared/plugin').PluginSource,
      scope: parsed.scope as import('../../shared/plugin').PluginScope,
      manifest: parsed.manifest as import('../../shared/plugin').Plugin['manifest'],
    };
    const plugin = installPlugin(getDb(), input);
    realtime.publish(makeLifecycleEvent('plugin.installed', { pluginId: plugin.id }, {}));
    recheckCapabilityBlocked(getDb()); // 安装即恢复被挂起的自动化（能力对账）
    res.status(201).json(plugin);
  }),
);

pluginsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    removePlugin(getDb(), param(req, 'id'));
    realtime.publish(makeLifecycleEvent('plugin.disabled', { pluginId: param(req, 'id') }, {}));
    recheckCapabilityBlocked(getDb()); // 卸载联动 → 依赖它的自动化重新对账挂起
    res.status(204).end();
  }),
);

// 测试 MCP server 连接（不落库，仅探测）。支持 stdio/sse/http 三种 transport。
pluginsRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const plugin = getPluginRow(getDb(), param(req, 'id'));
    if (plugin.manifest.kind !== 'mcp-server') {
      throw new AppError(ErrorCode.VALIDATION, '仅 MCP server 类 plugin 支持测试连接');
    }
    const mcp = plugin.manifest.mcp;
    if (mcp.transport === 'stdio') {
      if (!mcp.command) throw new AppError(ErrorCode.VALIDATION, 'MCP server 缺少 command');
    } else if (mcp.transport === 'sse' || mcp.transport === 'http') {
      if (!mcp.url) throw new AppError(ErrorCode.VALIDATION, `MCP server 缺少 url（${mcp.transport} transport）`);
    } else {
      throw new AppError(ErrorCode.VALIDATION, `不支持的 transport：${mcp.transport as string}`);
    }
    const pool = new McpClientPool();
    try {
      const tools = await pool.connect({
        id: plugin.id,
        transport: mcp.transport,
        command: mcp.command,
        args: mcp.args,
        env: mcp.env,
        url: mcp.url,
        headers: mcp.headers,
      });
      res.json({ ok: true, tools });
    } catch (e) {
      res.status(200).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      await pool.close();
    }
  }),
);


// ── Marketplace 检索 + 安装（B3b）─────────────────────────────────────────

pluginsRouter.get(
  '/marketplace/search',
  asyncHandler(async (req, res) => {
    const query = (req.query.q as string) ?? '';
    const includeGithub = req.query.github !== '0';
    res.json(searchMarketplace(query, { includeGithub }));
  }),
);

const installEntrySchema = z.object({
  entry: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    source: z.enum(['local', 'github']),
    ref: z.string(),
    kind: z.enum(['skill', 'mcp-server']),
    maturity: z.enum(['experimental', 'stable', 'deprecated']),
  }),
  scope: z.object({ level: z.enum(['platform', 'workbench', 'project', 'employee']) }).passthrough(),
});

pluginsRouter.post(
  '/marketplace/install',
  asyncHandler(async (req, res) => {
    const input = installEntrySchema.parse(req.body);
    const plugin = installMarketplaceEntry(
      getDb(),
      input.entry as MarketplaceEntry,
      input.scope as InstallScope,
    );
    realtime.publish(makeLifecycleEvent('plugin.installed', { pluginId: plugin.id }, {}));
    recheckCapabilityBlocked(getDb()); // 安装即恢复被挂起的自动化（能力对账）
    res.status(201).json(plugin);
  }),
);

// ── 预置策展目录（M1：官方精品 + muster 内去重）──────────────────────────

pluginsRouter.get(
  '/marketplace/presets',
  asyncHandler(async (_req, res) => {
    res.json(listMarketplacePresets(getDb()));
  }),
);

/** M3 官方源搜索：预置 + MCP Registry + anthropics skills 目录（分组 + 安装状态）。 */
pluginsRouter.get(
  '/marketplace/catalog',
  asyncHandler(async (req, res) => {
    const query = (req.query.q as string) ?? '';
    res.json(await searchMarketplaceCatalog(getDb(), query));
  }),
);

// ── M3 来源登记（official 白名单展示 + manual 未审核登记）─────────────────

pluginsRouter.get(
  '/marketplace/sources',
  asyncHandler(async (_req, res) => {
    res.json(listMarketplaceSources(getDb()));
  }),
);

const addSourceSchema = z.object({ endpoint: z.string().min(1) });

pluginsRouter.post(
  '/marketplace/sources',
  asyncHandler(async (req, res) => {
    const input = addSourceSchema.parse(req.body);
    res.status(201).json(addMarketplaceSource(getDb(), input.endpoint));
  }),
);

const installPresetSchema = z.object({
  presetId: z.string().min(1),
  scope: z.discriminatedUnion('level', [
    z.object({ level: z.literal('platform') }),
    z.object({ level: z.literal('workbench') }),
  ]),
  replaceExisting: z.boolean().optional(),
});

pluginsRouter.post(
  '/marketplace/install-preset',
  asyncHandler(async (req, res) => {
    const input = installPresetSchema.parse(req.body);
    const db = getDb();
    // 工作台级安装/停旧属于组织能力配置变更：与其它启停路由一致，要求工作台下班（org 配置锁）
    if (input.scope.level === 'workbench') assertWorkbenchOff(db);
    const scope = input.scope.level === 'platform'
      ? { level: 'platform' as const }
      : { level: 'workbench' as const };
    const plugin = await installPreset(db, input.presetId, scope, {
      replaceExisting: input.replaceExisting,
    });
    realtime.publish(makeLifecycleEvent('plugin.installed', { pluginId: plugin.id }, {}));
    recheckCapabilityBlocked(getDb()); // 安装即恢复被挂起的自动化（能力对账）
    res.status(201).json({ ...plugin, presetId: input.presetId });
  }),
);

/** Claude Code 官方插件安装（映射为 skill：plugin 描述 + commands/agents 指令组装注入）。 */
const installClaudePluginSchema = z.object({
  pluginName: z.string().min(1),
  scope: z.discriminatedUnion('level', [
    z.object({ level: z.literal('platform') }),
    z.object({ level: z.literal('workbench') }),
  ]),
  replaceExisting: z.boolean().optional(),
});

pluginsRouter.post(
  '/marketplace/install-claude-plugin',
  asyncHandler(async (req, res) => {
    const input = installClaudePluginSchema.parse(req.body);
    const db = getDb();
    if (input.scope.level === 'workbench') assertWorkbenchOff(db);
    const scope = input.scope.level === 'platform'
      ? { level: 'platform' as const }
      : { level: 'workbench' as const };
    const plugin = await installClaudeCodePlugin(db, input.pluginName, scope, {
      replaceExisting: input.replaceExisting,
    });
    realtime.publish(makeLifecycleEvent('plugin.installed', { pluginId: plugin.id }, {}));
    recheckCapabilityBlocked(getDb()); // 安装即恢复被挂起的自动化（能力对账）
    res.status(201).json({ ...plugin, pluginName: input.pluginName });
  }),
);

// ── AI 兜底起草（B3b）─────────────────────────────────────────────────────

pluginsRouter.post(
  '/author/skill',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        capability: z.string().min(1),
        context: z.string().optional(),
        scope: z.enum(['platform', 'workbench']).optional(),
      })
      .parse(req.body);
    const plugin = await authorSkill(getDb(), input);
    realtime.publish(makeLifecycleEvent('plugin.installed', { pluginId: plugin.id }, {}));
    recheckCapabilityBlocked(getDb()); // 安装即恢复被挂起的自动化（能力对账）
    res.status(201).json(plugin);
  }),
);
