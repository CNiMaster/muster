/**
 * MCP Client 连接池（B3a stdio + B6 SSE/HTTP）。
 *
 * 管理 MCP server 的连接生命周期（三种 transport）：
 * - stdio：spawn 本地子进程（command/args/env）
 * - sse：Server-Sent Events 远程 server（url/headers）
 * - http：Streamable HTTP 远程 server（url/headers，MCP 推荐的现代 transport）
 *
 * - 懒连接：首次需要某 server 的工具时才建立连接
 * - 复用：同一 server 在同一 task 内复用连接
 * - 探测：连接后 listTools 获取工具清单
 * - 超时：连接/请求超时由调用方（watchdog）兜底，池内设上限
 * - 关闭：task 结束时统一 close 所有连接
 *
 * 完全通用：接收任意 MCP server 配置，不绑定特定 server。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { log } from '../../../logger';

/** MCP server 配置（对应 Plugin.manifest.mcp 的运行时形态）。 */
export interface McpServerConfig {
  id: string;
  /** 连接方式。stdio=本地子进程；sse/http=远程 server。 */
  transport: 'stdio' | 'sse' | 'http';
  /** stdio: 启动命令。 */
  command?: string;
  args?: string[];
  /** stdio: 子进程环境变量。 */
  env?: Record<string, string>;
  /** sse/http: server URL。 */
  url?: string;
  /** sse/http: 请求头（如 Authorization）。 */
  headers?: Record<string, string>;
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
  tools: McpToolDescriptor[];
  connectedAt: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * 根据 config 创建对应 transport 实例（stdio/sse/http 分发）。
 * 抽出来便于测试 mock。
 */
function createTransport(config: McpServerConfig):
  | StdioClientTransport
  | SSEClientTransport
  | StreamableHTTPClientTransport {
  const requestInit = config.headers
    ? { headers: config.headers }
    : undefined;
  switch (config.transport) {
    case 'sse': {
      if (!config.url) throw new Error(`MCP server ${config.id} 缺少 url（sse transport）`);
      return new SSEClientTransport(new URL(config.url), requestInit ? { requestInit } : {});
    }
    case 'http': {
      if (!config.url) throw new Error(`MCP server ${config.id} 缺少 url（http transport）`);
      return new StreamableHTTPClientTransport(new URL(config.url), requestInit ? { requestInit } : {});
    }
    case 'stdio':
    default: {
      if (!config.command) throw new Error(`MCP server ${config.id} 缺少 command（stdio transport）`);
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
      });
    }
  }
}

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

    const transport = createTransport(config);

    const client = new Client(
      { name: 'muster-executor', version: '1.0.0' },
      { capabilities: {} },
    );

    // 连接超时保护：超时后 close 触发 connect reject
    let timer: NodeJS.Timeout | undefined;
    const connectPromise = client.connect(transport).catch((e) => {
      throw new Error(`MCP server ${config.id} 连接失败：${e instanceof Error ? e.message : String(e)}`);
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          client.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`MCP server ${config.id} 连接超时（${CONNECT_TIMEOUT_MS}ms）`));
      }, CONNECT_TIMEOUT_MS);
    });

    try {
      await Promise.race([connectPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
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
        setTimeout(
          () => reject(new Error(`MCP 工具调用超时：${serverId}/${toolName} (${requestTimeoutMs}ms)`)),
          requestTimeoutMs,
        ),
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
    const closes = Array.from(this.connections.values()).map(async ({ client }) => {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    });
    await Promise.all(closes);
    this.connections.clear();
  }
}
