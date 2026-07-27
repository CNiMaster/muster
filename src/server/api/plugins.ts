/**
 * Plugin REST 路由（B3a）。
 *
 * 通用能力接入 API：用户通过这些路由安装任意 MCP server / skill / tool 配置，
 * 并按公司级启停。系统不关心具体是哪个能力，只做 CRUD + 启停 + 连接测试。
 *
 * - GET    /api/plugins                                列出（含 builtin 只读视图）
 * - GET    /api/plugins/:id                            单个详情
 * - POST   /api/plugins                                安装（写 plugin 表）
 * - DELETE /api/plugins/:id                            移除
 * - POST   /api/plugins/:id/test                       测试 MCP server 连接
 * - POST   /api/companies/:companyId/plugins/:id/enable   公司级启用
 * - POST   /api/companies/:companyId/plugins/:id/disable  公司级禁用
 * - GET    /api/companies/:companyId/plugins/enabled      公司级启用列表
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { listPlugins, getPlugin } from '../domain/plugin-adapter';
import {
  installPlugin,
  removePlugin,
  setCompanyPluginEnabled,
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

// 测试 MCP server 连接（不落库，仅探测）
pluginsRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const plugin = getPluginRow(getDb(), param(req, 'id'));
    if (plugin.manifest.kind !== 'mcp-server') {
      throw new AppError(ErrorCode.VALIDATION, '仅 MCP server 类 plugin 支持测试连接');
    }
    const mcp = plugin.manifest.mcp;
    if (mcp.transport !== 'stdio') {
      throw new AppError(ErrorCode.VALIDATION, '仅支持 stdio transport 测试');
    }
    if (!mcp.command) {
      throw new AppError(ErrorCode.VALIDATION, 'MCP server 缺少 command');
    }
    const pool = new McpClientPool();
    try {
      const tools = await pool.connect({
        id: plugin.id,
        command: mcp.command,
        args: mcp.args,
        env: mcp.env,
      });
      res.json({ ok: true, tools });
    } catch (e) {
      res.status(200).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      await pool.close();
    }
  }),
);

// 公司级启停
pluginsRouter.post(
  '/companies/:companyId/plugins/:id/enable',
  asyncHandler(async (req, res) => {
    assertCompanyOff(getDb(), param(req, 'companyId'));
    setCompanyPluginEnabled(getDb(), param(req, 'companyId'), param(req, 'id'), true);
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
    setCompanyPluginEnabled(getDb(), param(req, 'companyId'), param(req, 'id'), false);
    realtime.publish(
      makeLifecycleEvent('plugin.disabled', { pluginId: param(req, 'id') }, { companyId: param(req, 'companyId') }),
    );
    res.json({ ok: true });
  }),
);

pluginsRouter.get(
  '/companies/:companyId/plugins/enabled',
  asyncHandler(async (req, res) => {
    res.json(listEnabledCompanyPlugins(getDb(), param(req, 'companyId')));
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
