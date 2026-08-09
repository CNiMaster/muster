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
 * - POST   /api/companies/:companyId/plugins/:id/enable   撤销禁用（恢复平台默认）
 * - POST   /api/companies/:companyId/plugins/:id/disable  显式禁用某平台插件
 * - GET    /api/companies/:companyId/plugins/effective   公司实际生效的插件（含三态）
 * - GET    /api/companies/:companyId/plugins/enabled     公司生效 plugin id 列表（兼容旧）
 * - GET    /api/plugins/company-scoped/:companyId        公司独占插件列表
 * - POST   /api/companies/:companyId/plugins/exclusive   安装公司独占插件
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { listPlugins, getPlugin } from '../domain/plugin-adapter';
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
import { authorSkill } from '../domain/skill-author';
import { getCompany } from '../domain/company';
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';
import { AppError, ErrorCode } from '../../shared/errors';

/** 组织配置锁：启停 plugin 需公司下班。 */
function assertCompanyOff(db: ReturnType<typeof getDb>, companyId: string): void {
  const company = getCompany(db, companyId);
  if (company.state !== 'off') {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '公司上班期间不能修改能力配置，请先让公司下班');
  }
}

export const pluginsRouter = Router();

pluginsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(listPlugins(getDb()));
  }),
);

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
  kind: z.enum(['skill', 'mcp-server', 'tool', 'bridge-action', 'ai-generated']),
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
    const input = {
      ...parsed,
      source: parsed.source as import('../../shared/plugin').PluginSource,
      scope: parsed.scope as import('../../shared/plugin').PluginScope,
      manifest: parsed.manifest as import('../../shared/plugin').Plugin['manifest'],
    };
    const plugin = installPlugin(getDb(), input);
    realtime.publish(makeLifecycleEvent('plugin.installed', { pluginId: plugin.id }, {}));
    res.status(201).json(plugin);
  }),
);

pluginsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    removePlugin(getDb(), param(req, 'id'));
    realtime.publish(makeLifecycleEvent('plugin.disabled', { pluginId: param(req, 'id') }, {}));
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

// 公司级启停（opt-out 语义）
pluginsRouter.post(
  '/companies/:companyId/plugins/:id/enable',
  asyncHandler(async (req, res) => {
    assertCompanyOff(getDb(), param(req, 'companyId'));
    // opt-out：enable = 撤销禁用，恢复平台默认全开
    setCompanyPluginDecision(getDb(), param(req, 'companyId'), param(req, 'id'), 'enabled');
    realtime.publish(
      makeLifecycleEvent('plugin.enabled', { pluginId: param(req, 'id') }, { companyId: param(req, 'companyId') }),
    );
    res.json({ ok: true });
  }),
);

pluginsRouter.post(
  '/companies/:companyId/plugins/:id/disable',
  asyncHandler(async (req, res) => {
    assertCompanyOff(getDb(), param(req, 'companyId'));
    // opt-out：disable = 显式禁用某平台插件
    setCompanyPluginDecision(getDb(), param(req, 'companyId'), param(req, 'id'), 'disabled');
    realtime.publish(
      makeLifecycleEvent('plugin.disabled', { pluginId: param(req, 'id') }, { companyId: param(req, 'companyId') }),
    );
    res.json({ ok: true });
  }),
);

// 公司实际生效的插件（opt-out：平台默认 - 禁用 + 公司独占），含三态决策标注
pluginsRouter.get(
  '/companies/:companyId/plugins/effective',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const companyId = param(req, 'companyId');
    const effective = getEffectivePluginsForCompany(db, companyId);
    const decisions = getCompanyPluginDecisions(db, companyId);
    // 为每个插件标注该公司对其的三态决策：default（平台默认全开）/ enabled（显式启用痕迹）/ disabled（显式禁用）/ exclusive（公司独占）
    const annotated = effective.map((p) => {
      let companyDecision: 'default' | 'enabled' | 'disabled' | 'exclusive';
      if (p.scope.level === 'company' && p.scope.companyId === companyId) {
        companyDecision = 'exclusive';
      } else {
        companyDecision = (decisions.get(p.id) as 'enabled' | 'disabled' | undefined) ?? 'default';
      }
      return { ...p, companyDecision };
    });
    res.json(annotated);
  }),
);

pluginsRouter.get(
  '/companies/:companyId/plugins/enabled',
  asyncHandler(async (req, res) => {
    // opt-out 迁移后语义=effective，保留旧路由名兼容历史调用方
    res.json(listEnabledCompanyPlugins(getDb(), param(req, 'companyId')));
  }),
);

// 公司独占插件列表（scope=company 且 scope_id===companyId）
pluginsRouter.get(
  '/company-scoped/:companyId',
  asyncHandler(async (req, res) => {
    res.json(listPlugins(getDb(), { scopeLevel: 'company', scopeCompanyId: param(req, 'companyId') }));
  }),
);

// 安装公司独占插件（scope=company，仅对目标公司可见可用）
const exclusiveInstallSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  kind: z.enum(['skill', 'mcp-server', 'tool', 'bridge-action', 'ai-generated']),
  source: z.unknown(),
  manifest: z.record(z.unknown()),
  permissions: z.array(z.string()).optional(),
  credentialKeys: z.array(z.string()).optional(),
  maturity: z.enum(['experimental', 'stable', 'deprecated']).optional(),
});

pluginsRouter.post(
  '/companies/:companyId/plugins/exclusive',
  asyncHandler(async (req, res) => {
    assertCompanyOff(getDb(), param(req, 'companyId'));
    const parsed = exclusiveInstallSchema.parse(req.body);
    const plugin = installPlugin(getDb(), {
      ...parsed,
      source: parsed.source as import('../../shared/plugin').PluginSource,
      // 强制 scope 为公司独占：仅目标公司可见
      scope: { level: 'company', companyId: param(req, 'companyId') },
      manifest: parsed.manifest as import('../../shared/plugin').Plugin['manifest'],
    });
    realtime.publish(
      makeLifecycleEvent('plugin.installed', { pluginId: plugin.id }, { companyId: param(req, 'companyId') }),
    );
    res.status(201).json(plugin);
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
  scope: z.object({ level: z.enum(['platform', 'company', 'project', 'employee']) }).passthrough(),
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
    res.status(201).json(plugin);
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
        companyId: z.string().optional(),
      })
      .parse(req.body);
    const plugin = await authorSkill(getDb(), input);
    realtime.publish(makeLifecycleEvent('plugin.installed', { pluginId: plugin.id }, {}));
    res.status(201).json(plugin);
  }),
);
