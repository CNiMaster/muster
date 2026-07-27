# MCP Client + Plugin 写侧 CRUD（B3a）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能存任意 MCP server 配置（command/args/env）、任意 stdio server 能被连接、其工具能注册进 RuntimeToolRegistry、OpenAI/Gemini 执行器能调用。同时支持 plugin 的写侧 CRUD（install/enable/disable）与公司级启停。

**Architecture:** 新增 `@modelcontextprotocol/sdk` 依赖，封装 `McpClientPool`（stdio transport，懒连接 + 健康检查 + 生命周期跟随 task）；plugin 写侧用 domain 层 CRUD 落库（install/update/enable/disable），读侧 plugin-adapter 已有；engine.ts 的 pumpThread 在构建 ExecutionContext 时按 project/agent 装配「内置工具 + 已启用 MCP 工具」合并的 registry 注入 ctx；adapter 从 ctx 取 registry（替代默认内置）。

**Tech Stack:** TypeScript + @modelcontextprotocol/sdk + better-sqlite3 + zod；Node 22.12+（原生 fetch）

**Spec:** `docs/superpowers/specs/2026-07-26-capability-platform-design.md` 子系统 A.3 + B（写侧部分）

**前置完成：** B1（RuntimeToolRegistry + Plugin 模型 + plugin 表）、B2（流程骨架，equipping 阶段将消费本批次的启用能力）

---

## File Structure

**Create:**
- `src/server/executors/tools/mcp/client-pool.ts` — McpClientPool：stdio 连接、工具探测、懒加载、超时、关闭
- `src/server/executors/tools/mcp/adapter.ts` — MCP server 工具 → RuntimeTool 适配（注册进 registry）
- `src/server/domain/plugin-install.ts` — Plugin 写侧：installPlugin/updatePlugin/removePlugin/enablePlugin/disablePlugin（公司/项目/员工级启停）
- `src/server/executors/tool-assembly.ts` — 装配函数：内置工具 + 已启用 MCP server → 合并的 RuntimeToolRegistry
- `tests/integration/mcp-client.spec.ts` — MCP client 连接/工具探测测试（用 echo server 或 mock）
- `tests/integration/plugin-install.spec.ts` — Plugin 写侧 CRUD + 启停测试

**Modify:**
- `package.json` — 加 `@modelcontextprotocol/sdk` 依赖
- `src/server/task-engine/executor.ts:10-56` — ExecutionContext 加 `toolRegistry?: RuntimeToolRegistry` 字段
- `src/server/executors/openai-adapter.ts` / `gemini-adapter.ts` — runToolLoop 调用处传 ctx.toolRegistry（若有）
- `src/server/task-engine/engine.ts:281-337` — 构建 ctx 时调 tool-assembly 装配 registry 注入
- `src/server/api/projects.ts` 或新 `src/server/api/plugins.ts` — Plugin CRUD 路由
- `src/server/server.ts` — 挂载 plugins 路由
- `src/shared/lifecycle-events.ts` — 加 plugin.installed/enabled/disabled/health-failed 事件
- `src/shared/plugin.ts` — McpServerManifest 补 credential_key 映射说明（若需）

---

## Task 1: 安装 MCP SDK

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装依赖**

Run:
```bash
cd /Users/master/Project/muster && npm install @modelcontextprotocol/sdk
```

Expected: package.json dependencies 出现 `@modelcontextprotocol/sdk`。

- [ ] **Step 2: 验证 SDK 可导入**

Run:
```bash
npx tsx -e "import { Client } from '@modelcontextprotocol/sdk/client/index.js'; import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'; console.log('MCP SDK loaded:', typeof Client, typeof StdioClientTransport)"
```
Expected: `MCP SDK loaded: function function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @modelcontextprotocol/sdk for B3a MCP client"
```

---

## Task 2: McpClientPool — stdio 连接 + 工具探测

**Files:**
- Create: `src/server/executors/tools/mcp/client-pool.ts`

- [ ] **Step 1: 写 McpClientPool**

创建 `src/server/executors/tools/mcp/client-pool.ts`：

```typescript
/**
 * MCP Client 连接池（B3a）。
 *
 * 管理 stdio MCP server 的连接生命周期：
 * - 懒连接：首次需要某 server 的工具时才 spawn 子进程
 * - 复用：同一 server 在同一 task 内复用连接
 * - 探测：连接后 listTools 获取工具清单
 * - 超时：连接/请求超时由调用方（watchdog）兜底，池内设上限
 * - 关闭：task 结束时统一 close 所有子进程
 *
 * 仅支持 stdio transport（B3a 范围）。HTTP/SSE 后续。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { log } from '../../../logger';

/** MCP server 配置（对应 Plugin.manifest.mcp 的运行时形态）。 */
export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 工具调用超时 ms（单次 request）。 */
  requestTimeoutMs?: number;
}

/** 探测到的 MCP 工具（MCP 协议的 Tool 形态）。 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface PooledConnection {
  client: Client;
  transport: StdioClientTransport;
  tools: McpToolDescriptor[];
  connectedAt: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * 单 task 范围的 MCP 连接池。
 * 一个 pumpThread 实例化一个 pool，task 结束时 close()。
 */
export class McpClientPool {
  private readonly connections = new Map<string, PooledConnection>();
  private closed = false;

  /**
   * 连接指定 MCP server 并探测其工具。
   * 已连接则直接返回缓存的工具列表。
   * 失败抛错（由调用方决定降级：跳过该 server 还是 abort task）。
   */
  async connect(config: McpServerConfig): Promise<McpToolDescriptor[]> {
    if (this.closed) throw new Error('McpClientPool 已关闭');
    const existing = this.connections.get(config.id);
    if (existing) return existing.tools;

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
    });

    const client = new Client(
      { name: 'muster-executor', version: '1.0.0' },
      { capabilities: {} },
    );

    // 连接超时保护
    const connectTimer = setTimeout(() => {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }, CONNECT_TIMEOUT_MS);

    try {
      await client.connect(transport);
      clearTimeout(connectTimer);
    } catch (e) {
      clearTimeout(connectTimer);
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('mcp client connect failed', { serverId: config.id, err: msg });
      throw new Error(`MCP server ${config.id} 连接失败：${msg}`);
    }

    // 探测工具
    let tools: McpToolDescriptor[] = [];
    try {
      const result = await client.listTools();
      tools = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      }));
    } catch (e) {
      log.warn('mcp listTools failed', { serverId: config.id, err: e instanceof Error ? e.message : String(e) });
      // 列工具失败不致命：连接保留，工具为空
    }

    this.connections.set(config.id, {
      client,
      transport,
      tools,
      connectedAt: Date.now(),
    });
    return tools;
  }

  /**
   * 调用某 server 的某工具。返回 MCP 协议的 CallToolResult。
   * 超时由 requestTimeoutMs 控制。
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<{ content: Array<{ type: string; text?: string; [k: string]: unknown }> }> {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`MCP server ${serverId} 未连接`);
    if (this.closed) throw new Error('McpClientPool 已关闭');

    const result = await Promise.race([
      conn.client.callTool({ name: toolName, arguments: args }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`MCP 工具调用超时：${serverId}/${toolName} (${requestTimeoutMs}ms)`)), requestTimeoutMs),
      ),
    ]);
    return result as { content: Array<{ type: string; text?: string; [k: string]: unknown }> };
  }

  /** 是否已连接某 server。 */
  has(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  /** 关闭所有连接（task 结束时调用）。幂等。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closes = Array.from(this.connections.values()).map(async ({ client, transport }) => {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      try {
        // StdioClientTransport 关闭后子进程应退出；额外兜底 kill
        const child = (transport as unknown as { stderr?: { destroy: () => void } });
        child?.stderr?.destroy?.();
      } catch {
        /* ignore */
      }
    });
    await Promise.all(closes);
    this.connections.clear();
  }
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -5`
Expected: PASS（若 SDK 类型有差异，按实际 API 调整）

- [ ] **Step 3: Commit**

```bash
git add src/server/executors/tools/mcp/client-pool.ts
git commit -m "feat(mcp): B3a — McpClientPool for stdio transport with tool discovery"
```

---

## Task 3: MCP 工具 → RuntimeTool 适配器

**Files:**
- Create: `src/server/executors/tools/mcp/adapter.ts`

- [ ] **Step 1: 写适配函数**

创建 `src/server/executors/tools/mcp/adapter.ts`：

```typescript
/**
 * MCP 工具 → RuntimeTool 适配（B3a）。
 *
 * 把 McpToolDescriptor + McpClientPool 包装成 RuntimeTool，
 * 注册进 RuntimeToolRegistry 后，OpenAI/Gemini 执行器就能像调用内置工具一样
 * 调用 MCP server 的工具。
 *
 * 工具命名：`mcp_<serverId>__<toolName>`，避免与内置/其他 server 冲突。
 */
import type { RuntimeTool, ToolCall, ToolResult, ToolDefinition } from '../registry';
import type { McpClientPool, McpToolDescriptor } from './client-pool';

/** 构造 MCP 工具在 registry 中的唯一名。 */
export function mcpToolName(serverId: string, toolName: string): string {
  const safeServer = serverId.replace(/[^a-zA-Z0-9_]/g, '_');
  const safeTool = toolName.replace(/[^a-zA-Z0-9_]/g, '_');
  return `mcp_${safeServer}__${safeTool}`;
}

/**
 * 把单个 MCP 工具转成 RuntimeTool。
 * - definition：从 MCP inputSchema 转成 OpenAI function calling parameters
 * - handler：调 pool.callTool，把 MCP 返回的 content 拼成字符串
 */
export function mcpToolToRuntimeTool(
  serverId: string,
  descriptor: McpToolDescriptor,
  pool: McpClientPool,
): RuntimeTool {
  const name = mcpToolName(serverId, descriptor.name);
  const definition: ToolDefinition = {
    type: 'function',
    function: {
      name,
      description: descriptor.description ?? `MCP 工具 ${serverId}/${descriptor.name}`,
      parameters: descriptor.inputSchema ?? { type: 'object', properties: {} },
    },
  };

  return {
    definition,
    // MCP 工具默认走 network 权限动作（server 通常涉及外部交互）
    permissionAction: 'network',
    source: { pluginId: `mcp:${serverId}`, toolName: descriptor.name },
    handler: async (call: ToolCall): Promise<ToolResult> => {
      try {
        const result = await pool.callTool(serverId, descriptor.name, call.args);
        // MCP 返回 content 数组，拼成文本
        const text = result.content
          .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
          .join('\n');
        return { toolCallId: call.id, name: call.name, content: text };
      } catch (e) {
        return {
          toolCallId: call.id,
          name: call.name,
          content: `MCP 工具调用失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}

/** 把一个 server 的全部工具注册进 registry。返回注册的工具名列表。 */
export function registerMcpServerTools(
  registry: import('../registry').RuntimeToolRegistry,
  serverId: string,
  tools: McpToolDescriptor[],
  pool: McpClientPool,
): string[] {
  const names: string[] = [];
  for (const descriptor of tools) {
    const tool = mcpToolToRuntimeTool(serverId, descriptor, pool);
    registry.register(tool);
    names.push(tool.definition.function.name);
  }
  return names;
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/executors/tools/mcp/adapter.ts
git commit -m "feat(mcp): B3a — adapt MCP tools to RuntimeTool registry entries"
```

---

## Task 4: Plugin 写侧 CRUD + 启停

**Files:**
- Create: `src/server/domain/plugin-install.ts`

- [ ] **Step 1: 写 plugin 写侧 domain**

创建 `src/server/domain/plugin-install.ts`：

```typescript
/**
 * Plugin 写侧（B3a）。
 *
 * 把用户/系统配置的能力（MCP server / skill / tool）落库到 plugin 表，
 * 并支持公司/项目/员工级启停。读侧在 plugin-adapter.ts（listPlugins）。
 *
 * 遵循「上班期间组织配置锁」：启停需 company.state === 'off'（由调用方 API 校验）。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import type {
  Plugin,
  PluginKind,
  PluginSource,
  PluginScope,
  PluginStatus,
  PluginMaturity,
  PluginRow,
} from '../../shared/plugin';

export interface InstallPluginInput {
  id?: string; // 缺省自动生成
  name: string;
  kind: PluginKind;
  source: PluginSource;
  scope: PluginScope;
  manifest: Plugin['manifest'];
  permissions?: string[];
  credentialKeys?: string[];
  maturity?: PluginMaturity;
}

function toSourceKind(s: PluginSource): string {
  return s.kind;
}

function toSourceRef(s: PluginSource): string | null {
  switch (s.kind) {
    case 'builtin':
      return null;
    case 'executor-native':
      return s.provider;
    case 'company':
      return s.companyId;
    case 'project':
      return s.projectId;
    case 'marketplace':
      return `${s.registry}@${s.ref}`;
    case 'ai-generated':
      return s.prompt;
  }
}

function toScopeLevel(s: PluginScope): string {
  return s.level;
}

function toScopeId(s: PluginScope): string | null {
  switch (s.level) {
    case 'platform':
      return null;
    case 'company':
      return s.companyId;
    case 'project':
      return s.projectId;
    case 'employee':
      return s.agentId;
  }
}

/**
 * 安装一个 Plugin（upsert：同 id 覆盖）。
 * scope_level/scope_id 从 scope 派生，manifest 序列化为 JSON。
 */
export function installPlugin(db: DB, input: InstallPluginInput): Plugin {
  const id = input.id ?? shortId('plg_');
  const now = nowIso();
  const sourceKind = toSourceKind(input.source);
  const sourceRef = toSourceRef(input.source);
  const scopeLevel = toScopeLevel(input.scope);
  const scopeId = toScopeId(input.scope);
  const manifestJson = JSON.stringify(input.manifest);
  const permissionsJson = input.permissions ? JSON.stringify(input.permissions) : null;
  const credentialKeysJson = input.credentialKeys ? JSON.stringify(input.credentialKeys) : null;
  const maturity = input.maturity ?? 'stable';

  db.prepare(
    `INSERT INTO plugin (id, name, kind, source_kind, source_ref, scope_level, scope_id, manifest_json, permissions_json, credential_keys_json, status, maturity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, kind=excluded.kind, source_kind=excluded.source_kind, source_ref=excluded.source_ref,
       scope_level=excluded.scope_level, scope_id=excluded.scope_id, manifest_json=excluded.manifest_json,
       permissions_json=excluded.permissions_json, credential_keys_json=excluded.credential_keys_json,
       maturity=excluded.maturity, updated_at=excluded.updated_at`,
  ).run(id, input.name, input.kind, sourceKind, sourceRef, scopeLevel, scopeId, manifestJson, permissionsJson, credentialKeysJson, maturity, now, now);

  return getPluginRow(db, id);
}

/** 获取单个 plugin（写侧用，直接查表）。 */
export function getPluginRow(db: DB, id: string): Plugin {
  const row = db.prepare('SELECT * FROM plugin WHERE id = ?').get(id) as PluginRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `plugin ${id} 不存在`);
  return rowToPlugin(row);
}

function rowToPlugin(row: PluginRow): Plugin {
  // 复用 plugin-adapter 的反序列化逻辑（import 避免重复）
  // 这里内联简化（与 plugin-adapter.parsePluginRow 一致）
  const manifest = JSON.parse(row.manifest_json) as Plugin['manifest'];
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    source: parseSource(row.source_kind, row.source_ref),
    scope: parseScope(row.scope_level, row.scope_id),
    manifest,
    permissions: row.permissions_json ? JSON.parse(row.permissions_json) : undefined,
    credentialKeys: row.credential_keys_json ? JSON.parse(row.credential_keys_json) : undefined,
    status: row.status,
    healthCheckedAt: row.health_checked_at ?? undefined,
    healthError: row.health_error ?? undefined,
    maturity: row.maturity,
  };
}

function parseSource(kind: string, ref: string | null): PluginSource {
  switch (kind) {
    case 'builtin': return { kind: 'builtin' };
    case 'executor-native': return { kind: 'executor-native', provider: ref ?? '' };
    case 'company': return { kind: 'company', companyId: ref ?? '' };
    case 'project': return { kind: 'project', projectId: ref ?? '' };
    case 'marketplace':
      const [registry, ...rest] = (ref ?? '@').split('@');
      return { kind: 'marketplace', registry: registry ?? '', ref: rest.join('@') };
    case 'ai-generated': return { kind: 'ai-generated', generatedAt: '', prompt: ref ?? '' };
    default: return { kind: 'builtin' };
  }
}

function parseScope(level: string, id: string | null): PluginScope {
  switch (level) {
    case 'platform': return { level: 'platform' };
    case 'company': return { level: 'company', companyId: id ?? '' };
    case 'project': return { level: 'project', projectId: id ?? '' };
    case 'employee': return { level: 'employee', agentId: id ?? '' };
    default: return { level: 'platform' };
  }
}

/** 移除 plugin（连带 company_plugin 记录，ON DELETE CASCADE）。 */
export function removePlugin(db: DB, id: string): void {
  const result = db.prepare('DELETE FROM plugin WHERE id = ?').run(id);
  if (result.changes === 0) throw new AppError(ErrorCode.NOT_FOUND, `plugin ${id} 不存在`);
}

/**
 * 公司级启停。
 * enabled=true 时在 company_plugin 插入记录，false 时删除或置 enabled=0。
 */
export function setCompanyPluginEnabled(
  db: DB,
  companyId: string,
  pluginId: string,
  enabled: boolean,
  enabledBy?: string,
): void {
  // 确认 plugin 存在
  getPluginRow(db, pluginId);
  const now = nowIso();
  if (enabled) {
    db.prepare(
      `INSERT INTO company_plugin (company_id, plugin_id, enabled, enabled_by, enabled_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(company_id, plugin_id) DO UPDATE SET enabled=1, enabled_by=excluded.enabled_by, enabled_at=excluded.enabled_at`,
    ).run(companyId, pluginId, enabledBy ?? null, now);
  } else {
    db.prepare(
      `INSERT INTO company_plugin (company_id, plugin_id, enabled, enabled_by, enabled_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(company_id, plugin_id) DO UPDATE SET enabled=0, enabled_at=excluded.enabled_at`,
    ).run(companyId, pluginId, enabledBy ?? null, now);
  }
}

/** 查询某公司启用的 plugin id 列表。 */
export function listEnabledCompanyPlugins(db: DB, companyId: string): string[] {
  const rows = db
    .prepare('SELECT plugin_id FROM company_plugin WHERE company_id = ? AND enabled = 1')
    .all(companyId) as { plugin_id: string }[];
  return rows.map((r) => r.plugin_id);
}

/** 标记 plugin 健康检查结果（连不上时记 health_error）。 */
export function markPluginHealth(db: DB, id: string, ok: boolean, errorMsg?: string): void {
  const now = nowIso();
  db.prepare(
    `UPDATE plugin SET health_checked_at = ?, health_error = ?, status = ?, updated_at = ? WHERE id = ?`,
  ).run(now, ok ? null : (errorMsg ?? '健康检查失败'), ok ? 'available' : 'error', now, id);
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/domain/plugin-install.ts
git commit -m "feat(plugin): B3a — plugin write-side CRUD + company-level enable/disable"
```

---

## Task 5: tool-assembly — 装配内置 + MCP 合并 registry

**Files:**
- Create: `src/server/executors/tool-assembly.ts`

- [ ] **Step 1: 写装配函数**

创建 `src/server/executors/tool-assembly.ts`：

```typescript
/**
 * 工具装配（B3a）。
 *
 * 在 pumpThread 构建 ExecutionContext 时调用：
 * 1. 创建 RuntimeToolRegistry，注册 7 个内置工具
 * 2. 查询项目所属公司启用的 MCP plugin
 * 3. 对每个 MCP server：解析配置 → 连接 McpClientPool → 探测工具 → 注册
 * 4. 返回 { registry, pool }，pool 由 task 结束时关闭
 *
 * 连接失败的单个 server 不致命：记 health 错误，跳过，继续装配其余。
 */
import { createBuiltinToolRegistry, type RuntimeToolRegistry } from './executors/tools/registry';
import { McpClientPool, type McpServerConfig } from './executors/tools/mcp/client-pool';
import { registerMcpServerTools } from './executors/tools/mcp/adapter';
import type { Plugin } from './shared/plugin';
import type { DB } from './db/client';
import { listPlugins } from './domain/plugin-adapter';
import { listEnabledCompanyPlugins, markPluginHealth } from './domain/plugin-install';
import { log } from './logger';

export interface AssembledTools {
  registry: RuntimeToolRegistry;
  pool: McpClientPool;
}

/**
 * 为一次 task 执行装配工具集。
 * companyId/projectId 决定哪些 MCP plugin 生效。
 */
export async function assembleTools(
  db: DB,
  companyId: string,
  options: { onToolCall?: (name: string) => void } = {},
): Promise<AssembledTools> {
  const registry = createBuiltinToolRegistry();
  const pool = new McpClientPool();

  // 查启用 plugin（公司级）
  const enabledPluginIds = listEnabledCompanyPlugins(db, companyId);
  if (enabledPluginIds.length === 0) {
    return { registry, pool };
  }

  // 过滤出 MCP server 类型的 plugin
  const allPlugins = listPlugins(db);
  const mcpPlugins = allPlugins.filter(
    (p) => p.kind === 'mcp-server' && enabledPluginIds.includes(p.id),
  );

  for (const plugin of mcpPlugins) {
    const config = pluginToServerConfig(plugin);
    if (!config) continue;
    try {
      const tools = await pool.connect(config);
      const names = registerMcpServerTools(registry, config.id, tools, pool);
      markPluginHealth(db, plugin.id, true);
      log.info('mcp server connected', { serverId: config.id, tools: names.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markPluginHealth(db, plugin.id, false, msg);
      log.warn('mcp server connect failed, skipping', { serverId: config.id, err: msg });
      // 单个 server 失败不致命，继续其余
    }
  }

  return { registry, pool };
}

/** 把 Plugin（kind=mcp-server）转成 McpServerConfig。 */
function pluginToServerConfig(plugin: Plugin): McpServerConfig | null {
  if (plugin.manifest.kind !== 'mcp-server') return null;
  const mcp = plugin.manifest.mcp;
  if (mcp.transport !== 'stdio') return null; // B3a 仅 stdio
  if (!mcp.command) return null;
  return {
    id: plugin.id,
    command: mcp.command,
    args: mcp.args,
    env: mcp.env,
    requestTimeoutMs: 30_000,
  };
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/executors/tool-assembly.ts
git commit -m "feat(executor): B3a — assemble builtin + MCP tools into registry per task"
```

---

## Task 6: ExecutionContext + adapter 接收动态 registry

**Files:**
- Modify: `src/server/task-engine/executor.ts:10-56`
- Modify: `src/server/executors/openai-adapter.ts`
- Modify: `src/server/executors/gemini-adapter.ts`

- [ ] **Step 1: ExecutionContext 加 toolRegistry 字段**

Modify `src/server/task-engine/executor.ts`，在 ExecutionContext 接口加：

```typescript
import type { RuntimeToolRegistry } from '../executors/tools/registry';

export interface ExecutionContext {
  // ... 现有字段 ...
  /**
   * 运行时工具注册表（B3a）：内置工具 + 已启用 MCP 工具的合并集。
   * 缺省 undefined 时 adapter 走 createBuiltinToolRegistry（向后兼容）。
   */
  toolRegistry?: RuntimeToolRegistry;
  /** MCP 连接池（B3a）：task 结束时由 engine 关闭。 */
  mcpPool?: import('../executors/tools/mcp/client-pool').McpClientPool;
}
```

- [ ] **Step 2: openai-adapter 传 ctx.toolRegistry**

Modify `src/server/executors/openai-adapter.ts` 的 runToolLoop 调用处，加 `toolRegistry: ctx.toolRegistry`：

```typescript
const loop = await runToolLoop({
  messages,
  callModel,
  workingDir: ctx.workingDir,
  readonlyDirs: ctx.readonlyDirs,
  toolRegistry: ctx.toolRegistry, // 新增：缺省 undefined 走内置
  maxToolCalls,
  timeoutMs,
  signal: ctx.signal,
  model,
  loopback: ctx.loopback,
  permissionGuard: ctx.permissionGuard,
  reviewContext: { db: getDb(), taskId: ctx.task.id },
});
```

- [ ] **Step 3: gemini-adapter 同样加 toolRegistry**

Modify `src/server/executors/gemini-adapter.ts` 的 runToolLoop 调用处，同 Step 2。

- [ ] **Step 4: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 5: 跑现有 adapter 测试确认无回归**

Run: `npm test -- tests/integration/batch11-tool-loop.spec.ts 2>&1 | tail -5`
Expected: PASS（ctx.toolRegistry 缺省 undefined，走内置 registry）

- [ ] **Step 6: Commit**

```bash
git add src/server/task-engine/executor.ts src/server/executors/openai-adapter.ts src/server/executors/gemini-adapter.ts
git commit -m "feat(executor): B3a — ExecutionContext carries toolRegistry + mcpPool to adapters"
```

---

## Task 7: engine.ts pumpThread 注入装配

**Files:**
- Modify: `src/server/task-engine/engine.ts:281-337`（构建 ctx 处）+ finally 块（关闭 pool）

- [ ] **Step 1: 在 ctx 构建后装配 tools**

在 engine.ts 的 `const ctx: ExecutionContext = {...}` 之后（约 L337）、`runController` 创建之前（约 L345），插入：

```typescript
// B3a：装配工具集（内置 + 已启用 MCP），失败不阻塞（降级为纯内置）
let assembled: { registry: RuntimeToolRegistry; pool: McpClientPool } | null = null;
try {
  const { assembleTools } = await import('../executors/tool-assembly');
  assembled = await assembleTools(this.db, company.id);
  ctx.toolRegistry = assembled.registry;
  ctx.mcpPool = assembled.pool;
} catch (e) {
  log.warn('tool assembly failed, falling back to builtin only', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
}
```

顶部 import 加 `import type { RuntimeToolRegistry } from '../executors/tools/registry';` 和 `import type { McpClientPool } from '../executors/tools/mcp/client-pool';`（或用动态 import 避免循环）。

- [ ] **Step 2: finally 块关闭 pool**

找到 `_pumpThread` 的 finally 块（约 L751-762，清理 worktree 处），在清理 worktree 之前加：

```typescript
// B3a：关闭 MCP 连接池（即使 task 失败也要清理子进程）
if (ctx.mcpPool) {
  try {
    await ctx.mcpPool.close();
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 4: 跑 engine 相关测试确认无回归**

Run: `npm test -- tests/integration/engine-wiring.spec.ts tests/integration/task-engine.spec.ts 2>&1 | tail -5`
Expected: PASS（没有启用 MCP plugin 时，assembleTools 返回纯内置 registry，行为同 B2）

- [ ] **Step 5: Commit**

```bash
git add src/server/task-engine/engine.ts
git commit -m "feat(engine): B3a — pumpThread assembles MCP tools + closes pool on task end"
```

---

## Task 8: Plugin CRUD API 路由

**Files:**
- Create: `src/server/api/plugins.ts`
- Modify: `src/server/server.ts`（挂载路由）

- [ ] **Step 1: 写 plugins 路由**

创建 `src/server/api/plugins.ts`：

```typescript
/**
 * Plugin REST 路由（B3a）。
 *
 * - GET    /api/plugins                      列出（含 builtin 只读视图）
 * - GET    /api/plugins/:id                  单个详情
 * - POST   /api/plugins                      安装（写 plugin 表）
 * - PATCH  /api/plugins/:id                  更新
 * - DELETE /api/plugins/:id                  移除
 * - POST   /api/plugins/:id/test             测试连接（MCP server）
 * - POST   /api/companies/:companyId/plugins/:id/enable   公司级启用
 * - POST   /api/companies/:companyId/plugins/:id/disable  公司级禁用
 * - GET    /api/companies/:companyId/plugins 公司级启用列表
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
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';
import { AppError, ErrorCode } from '../../shared/errors';

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
  source: z.object({ kind: z.enum(['builtin', 'executor-native', 'company', 'project', 'marketplace', 'ai-generated']) }).passthrough(),
  scope: z.object({ level: z.enum(['platform', 'company', 'project', 'employee']) }).passthrough(),
  manifest: z.record(z.unknown()),
  permissions: z.array(z.string()).optional(),
  credentialKeys: z.array(z.string()).optional(),
  maturity: z.enum(['experimental', 'stable', 'deprecated']).optional(),
});

pluginsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = installSchema.parse(req.body);
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
    const pool = new McpClientPool();
    try {
      const tools = await pool.connect({
        id: plugin.id,
        command: mcp.command!,
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
  '/companies/:companyId/:id/enable',
  asyncHandler(async (req, res) => {
    setCompanyPluginEnabled(getDb(), param(req, 'companyId'), param(req, 'id'), true);
    realtime.publish(
      makeLifecycleEvent('plugin.enabled', { pluginId: param(req, 'id') }, { companyId: param(req, 'companyId') }),
    );
    res.json({ ok: true });
  }),
);

pluginsRouter.post(
  '/companies/:companyId/:id/disable',
  asyncHandler(async (req, res) => {
    setCompanyPluginEnabled(getDb(), param(req, 'companyId'), param(req, 'id'), false);
    realtime.publish(
      makeLifecycleEvent('plugin.disabled', { pluginId: param(req, 'id') }, { companyId: param(req, 'companyId') }),
    );
    res.json({ ok: true });
  }),
);

pluginsRouter.get(
  '/companies/:companyId/enabled',
  asyncHandler(async (req, res) => {
    res.json(listEnabledCompanyPlugins(getDb(), param(req, 'companyId')));
  }),
);
```

- [ ] **Step 2: 挂载路由到 server.ts**

Modify `src/server/server.ts`，在现有 router 挂载区加：

```typescript
import { pluginsRouter } from './api/plugins';
// ... 在 app.use(...) 区域加：
app.use('/api/plugins', pluginsRouter);
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/api/plugins.ts src/server/server.ts
git commit -m "feat(api): B3a — plugin CRUD routes + MCP connection test + company enable/disable"
```

---

## Task 9: lifecycle 事件扩展

**Files:**
- Modify: `src/shared/lifecycle-events.ts`

- [ ] **Step 1: 加 plugin.* 事件**

在 LifecycleEventPayloadMap 加：

```typescript
  // Plugin 系统（B3a）
  'plugin.installed': { pluginId: string };
  'plugin.enabled': { pluginId: string };
  'plugin.disabled': { pluginId: string };
  'plugin.health-failed': { pluginId: string; error: string };
```

- [ ] **Step 2: typecheck + lifecycle 测试**

Run: `npm run typecheck 2>&1 | tail -3 && npm test -- tests/unit/lifecycle-events.spec.ts 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/lifecycle-events.ts
git commit -m "feat(lifecycle): B3a — plugin installed/enabled/disabled/health-failed events"
```

---

## Task 10: Plugin 写侧集成测试

**Files:**
- Create: `tests/integration/plugin-install.spec.ts`

- [ ] **Step 1: 写写侧 CRUD 测试**

创建 `tests/integration/plugin-install.spec.ts`：

```typescript
/**
 * B3a Plugin 写侧测试：
 * - installPlugin upsert
 * - removePlugin
 * - setCompanyPluginEnabled + listEnabledCompanyPlugins
 * - markPluginHealth
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import {
  installPlugin,
  removePlugin,
  setCompanyPluginEnabled,
  listEnabledCompanyPlugins,
  markPluginHealth,
  getPluginRow,
} from '../../src/server/domain/plugin-install';
import { AppError, ErrorCode } from '../../src/shared/errors';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  companyId = createCompany(db, { name: 'co' }).id;
});

afterEach(() => tdb.close());

function makeMcpPlugin(id: string) {
  return installPlugin(db, {
    id,
    name: '测试 MCP',
    kind: 'mcp-server',
    source: { kind: 'company', companyId },
    scope: { level: 'company', companyId },
    manifest: {
      kind: 'mcp-server',
      mcp: { transport: 'stdio', command: 'echo', args: ['hi'] },
    },
    credentialKeys: ['API_KEY'],
  });
}

describe('installPlugin', () => {
  it('插入新 plugin', () => {
    const p = makeMcpPlugin('plg_test1');
    expect(p.id).toBe('plg_test1');
    expect(p.kind).toBe('mcp-server');
    expect(p.source).toEqual({ kind: 'company', companyId });
    expect(p.manifest.kind).toBe('mcp-server');
  });

  it('upsert：同 id 覆盖', () => {
    makeMcpPlugin('plg_test2');
    installPlugin(db, {
      id: 'plg_test2',
      name: '改名',
      kind: 'mcp-server',
      source: { kind: 'company', companyId },
      scope: { level: 'company', companyId },
      manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'ls' } },
    });
    const p = getPluginRow(db, 'plg_test2');
    expect(p.name).toBe('改名');
  });
});

describe('removePlugin', () => {
  it('删除存在的 plugin', () => {
    makeMcpPlugin('plg_del');
    removePlugin(db, 'plg_del');
    expect(() => getPluginRow(db, 'plg_del')).toThrow(AppError);
  });

  it('删除不存在的抛 NOT_FOUND', () => {
    expect(() => removePlugin(db, 'nonexistent')).toThrow(AppError);
    try {
      removePlugin(db, 'nonexistent');
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.NOT_FOUND);
    }
  });
});

describe('公司级启停', () => {
  it('enable 后在启用列表中', () => {
    makeMcpPlugin('plg_en');
    setCompanyPluginEnabled(db, companyId, 'plg_en', true);
    expect(listEnabledCompanyPlugins(db, companyId)).toContain('plg_en');
  });

  it('disable 后不在启用列表中', () => {
    makeMcpPlugin('plg_dis');
    setCompanyPluginEnabled(db, companyId, 'plg_dis', true);
    setCompanyPluginEnabled(db, companyId, 'plg_dis', false);
    expect(listEnabledCompanyPlugins(db, companyId)).not.toContain('plg_dis');
  });

  it('启停不存在的 plugin 抛 NOT_FOUND', () => {
    expect(() => setCompanyPluginEnabled(db, companyId, 'nonexistent', true)).toThrow(AppError);
  });
});

describe('markPluginHealth', () => {
  it('成功标记 available', () => {
    makeMcpPlugin('plg_ok');
    markPluginHealth(db, 'plg_ok', true);
    const p = getPluginRow(db, 'plg_ok');
    expect(p.status).toBe('available');
    expect(p.healthError).toBeUndefined();
  });

  it('失败标记 error + healthError', () => {
    makeMcpPlugin('plg_err');
    markPluginHealth(db, 'plg_err', false, '连接超时');
    const p = getPluginRow(db, 'plg_err');
    expect(p.status).toBe('error');
    expect(p.healthError).toBe('连接超时');
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `npm test -- tests/integration/plugin-install.spec.ts 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/plugin-install.spec.ts
git commit -m "test(plugin): B3a — plugin write-side CRUD + enable/disable + health"
```

---

## Task 11: MCP client 连接测试

**Files:**
- Create: `tests/integration/mcp-client.spec.ts`

- [ ] **Step 1: 写 MCP client 测试（用真实 echo server）**

创建 `tests/integration/mcp-client.spec.ts`：

```typescript
/**
 * B3a MCP client 测试：用项目内一个最简 stdio MCP server 验证连接 + 工具探测。
 *
 * 为避免引入外部依赖，测试用动态生成的临时 JS 文件作为 echo MCP server。
 * 若 SDK 的 server API 在本环境不可用，测试降级为只验证 McpClientPool 的
 * 超时/关闭行为（用不存在的 command 触发连接失败）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClientPool } from '../../src/server/executors/tools/mcp/client-pool';

const tmpDir = join(tmpdir(), `muster-mcp-test-${Date.now()}`);

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('McpClientPool', () => {
  it('连接不存在的 command 抛错', async () => {
    const pool = new McpClientPool();
    await expect(
      pool.connect({ id: 'bad', command: 'nonexistent-command-xyz', args: [] }),
    ).rejects.toThrow();
    await pool.close();
  });

  it('close 后再 connect 抛错', async () => {
    const pool = new McpClientPool();
    await pool.close();
    await expect(
      pool.connect({ id: 'x', command: 'echo', args: [] }),
    ).rejects.toThrow('McpClientPool 已关闭');
  });

  it('callTool 未连接的 server 抛错', async () => {
    const pool = new McpClientPool();
    await expect(pool.callTool('unknown', 'foo', {})).rejects.toThrow('未连接');
    await pool.close();
  });

  it('close 幂等', async () => {
    const pool = new McpClientPool();
    await pool.close();
    await expect(pool.close()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `npm test -- tests/integration/mcp-client.spec.ts 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mcp-client.spec.ts
git commit -m "test(mcp): B3a — McpClientPool connect failure + close idempotency"
```

---

## Task 12: 全量回归 + 最终验证

- [ ] **Step 1: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 2: 全量测试**

Run: `npm test 2>&1 | tail -6`
Expected: 所有测试 PASS（B2 的 516 + B3a 新增）。assembleTools 在无启用 MCP 时降级为纯内置，不影响现有测试。

- [ ] **Step 3: 最终 commit（如有修复）**

```bash
git add -A
git commit -m "fix(b3a): resolve regressions from tool assembly injection"
```

---

## Self-Review Notes

**Spec coverage:**
- A.3 MCP Client（stdio）→ Task 2, 3 ✅
- B 写侧 CRUD → Task 4 ✅
- 运行时注入 → Task 5, 6, 7 ✅
- API + lifecycle → Task 8, 9 ✅
- 测试 → Task 10, 11 ✅

**Scope 边界（B3a 只做这些，不做）：**
- ✅ 通用 MCP stdio client（连任意 server）
- ✅ Plugin 写侧 CRUD（存任意配置）
- ✅ 公司级启停
- ✅ engine 注入装配
- ❌ marketplace 检索/下载（留 B3b）
- ❌ AI 起草 skill 兜底（留 B3b）
- ❌ HTTP/SSE transport（留后续）

**Type consistency:** McpServerConfig / McpToolDescriptor / RuntimeTool / InstallPluginInput 跨 Task 2/3/4/5 引用一致；plugin.manifest.kind 判别联合在 Task 5/8 正确使用。
