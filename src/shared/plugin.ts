/**
 * Plugin 统一模型（B1 骨干）。
 *
 * 把现存三种能力来源（Skill / Tool Registry / Bridge action）统一为一种形态，
 * 同时为后续 MCP server、AI 生成能力提供同一接口。设计目标：
 * - 零迁移：现有 23 个 skill / 5 类 tool / 4 个 bridge action 通过适配器包装为 Plugin 只读视图
 * - 统一消费：能力发现（B）、项目准备流程（C）、编排（D）只认 Plugin，不再区分三种机制
 * - 来源可追溯：source 字段记录能力来自何处（系统预制/执行器/公司项目/市场/AI）
 *
 * 详见 docs/superpowers/specs/2026-07-26-capability-platform-design.md A.1。
 *
 * 注意：本文件是「读侧契约」（描述能力是什么），运行时执行走 RuntimeToolRegistry
 * （src/server/executors/tools/registry.ts）。两者通过 pluginId 关联。
 */

/** 插件形态。每种对应一种 manifest 结构。 */
export type PluginKind = 'skill' | 'mcp-server' | 'tool' | 'bridge-action' | 'ai-generated' | 'panel' | 'hook';

/** 能力来源。 */
export type PluginSource =
  | { kind: 'builtin' }
  | { kind: 'executor-native'; provider: string }
  | { kind: 'workbench' }
  | { kind: 'project'; projectId: string }
  | { kind: 'marketplace'; registry: string; ref: string }
  | { kind: 'ai-generated'; generatedAt: string; prompt: string };

/** 生效范围。替换未来 agent.tools / agent.skills 的字符串数组。 */
export type PluginScope =
  | { level: 'platform' }
  | { level: 'workbench' }
  | { level: 'project'; projectId: string }
  | { level: 'employee'; agentId: string };

/** 生命周期状态。 */
export type PluginStatus = 'available' | 'enabled' | 'disabled' | 'error';

/** 成熟度，影响信任级别与启用流程。 */
export type PluginMaturity = 'experimental' | 'stable' | 'deprecated';

/**
 * Skill 类插件的 manifest。
 * 对应 skills/<id>/SKILL.md 解析结果（B1 阶段只存原始 markdown，B3 扩展结构化字段）。
 */
export interface SkillManifest {
  /** SKILL.md 全文或摘要（注入 prompt 用）。 */
  body: string;
  /** frontmatter 解析出的元数据（name/description 等），可能为空。 */
  frontmatter?: Record<string, unknown>;
}

/**
 * MCP server 类插件的 manifest（B3 批次填充）。
 * 第一版仅 stdio 本地 server。
 */
/**
 * MCP server 类插件的 manifest（B3a stdio + B6 SSE/HTTP）。
 *
 * transport 决定连接方式：
 * - stdio：spawn 本地子进程（command/args/env）
 * - sse：Server-Sent Events 远程 server（url + 可选 headers）
 * - http：Streamable HTTP 远程 server（url + 可选 headers，MCP 推荐的现代 transport）
 */
export interface McpServerManifest {
  transport: 'stdio' | 'sse' | 'http';
  /** stdio: 启动命令。 */
  command?: string;
  args?: string[];
  /** sse/http: server URL。 */
  url?: string;
  /** stdio: 子进程环境变量。 */
  env?: Record<string, string>;
  /** sse/http: 请求头（如 Authorization: Bearer xxx）。 */
  headers?: Record<string, string>;
  /** server 暴露的工具列表（连接后探测填充）。 */
  tools?: Array<{ name: string; description?: string }>;
}

/**
 * 自定义工具类插件的 manifest（B3 批次填充）。
 * 来自 tools/<cat>/<id>.md 的 frontmatter。
 */
export interface ToolManifest {
  /** 能力分类（document/embedding/speech-to-text/tts/video 等）。 */
  capability: string;
  /** 实现方式：local=本地进程，api=远程 API。 */
  implementation: 'local' | 'api';
  /** 适配的执行器类型。 */
  executorKind?: string;
  /** 安装/检查命令（frontmatter 的 install/check 字段）。 */
  install?: string;
  check?: string;
}

/** Bridge action 类插件的 manifest（对应 bridge.ts 的 BRIDGE_ACTIONS）。 */
export interface BridgeActionManifest {
  /** HTTP 方法。 */
  method: 'GET' | 'POST';
  /** 参数说明。 */
  params?: Array<{ name: string; description: string; required?: boolean }>;
  /** 完整的 prompt 注入说明（来自 bridge.ts buildBridgePromptSection）。 */
  promptSection: string;
}

/** 面板插件 manifest（批次 I-a）：entry=项目内相对 HTML 路径，右栏 iframe 沙箱承载。 */
export interface PanelPluginManifest {
  /** 项目内相对路径，必须 .html 结尾（resolveArtifactPath 三防线校验）。 */
  entry: string;
  /** 展示标题（折叠卡+iframe title）。 */
  title: string;
  /** 初始高度 px；'auto'=等插件 ready 消息上报。上限 720。 */
  height?: number | 'auto';
}

/** 判别联合：根据 kind 选用对应 manifest。 */
export type PluginManifest =
  | { kind: 'skill'; skill: SkillManifest }
  | { kind: 'mcp-server'; mcp: McpServerManifest }
  | { kind: 'tool'; tool: ToolManifest }
  | { kind: 'bridge-action'; bridge: BridgeActionManifest }
  | { kind: 'ai-generated'; skill: SkillManifest } // AI 生成复用 SkillManifest 结构
  | { kind: 'panel'; panel: PanelPluginManifest };

/**
 * Plugin：能力的统一形态。
 * 一个 Plugin 描述「这是什么能力、来自哪、给谁用、怎么运行」。
 */
export interface Plugin {
  /** 全局唯一 ID。skill 用 skillId，tool 用 toolId，bridge 用 action 名，MCP 自定义。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 形态。 */
  kind: PluginKind;
  /** 来源。 */
  source: PluginSource;
  /** 生效范围。 */
  scope: PluginScope;
  /** 形态特定的 manifest。 */
  manifest: PluginManifest;
  /** 声明的权限（如 'network'、'write-file'），用于权限策略匹配。 */
  permissions?: string[];
  /** 需要的凭据 key（复用 tool-registry 的 credential_keys 模式）。 */
  credentialKeys?: string[];
  /** 生命周期状态。 */
  status: PluginStatus;
  /** 最近一次健康检查时间。 */
  healthCheckedAt?: string;
  /** 健康检查失败原因。 */
  healthError?: string;
  /** 成熟度。 */
  maturity: PluginMaturity;
}

/** Plugin 数据库行的类型（plugin 表的字段映射，B3 批次写入侧使用）。 */
export interface PluginRow {
  id: string;
  name: string;
  kind: PluginKind;
  source_kind: PluginSource['kind'];
  source_ref: string | null;
  scope_level: PluginScope['level'];
  scope_id: string | null;
  manifest_json: string;
  permissions_json: string | null;
  credential_keys_json: string | null;
  status: PluginStatus;
  health_checked_at: string | null;
  health_error: string | null;
  maturity: PluginMaturity;
  created_at: string;
  updated_at: string;
}
