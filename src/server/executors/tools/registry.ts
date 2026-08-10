/**
 * 运行时工具注册表（B1 骨干）。
 *
 * 替代 file-tools.ts 里写死的 FILE_TOOLS + switch 分发。借鉴 bridge.ts:37 的
 * 「单一事实来源注册表」模式：一个 RuntimeTool 同时驱动
 *   - 工具定义（给模型 function calling）
 *   - 执行 handler（模型 tool_call 时分发）
 *   - 权限动作（喂给 permissionGuard）
 *
 * 安全不变量沿用 file-tools：
 * - 文件操作限制在 workingDir 内（isWithinWorkspace 校验）
 * - readonlyDirs 可读不可写
 * - done 工具结束循环并产出 AgentRunResult
 *
 * 第一版注册 muster 内置的 7 个工具（read/write/edit/list/done/notify_host/submit_review），
 * 行为与原 file-tools.ts 的 switch 完全一致。后续批次会把 MCP 工具、自定义工具、
 * AI 生成工具按同一接口注册进来。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolve } from 'node:path';
import { isWithinWorkspace, checkBashCommand } from '../../sandbox';
import { classifyCommand } from '../cli-permission-bridge';
import { agentRunResultSchema } from '../result-schema';
import { submitBusinessReview, type BusinessReviewKind } from '../../domain/business-review';
import { createTask, addDependency } from '../../domain/task';
import { addTaskMessage } from '../../domain/task-message';
import { postSystemMessage } from '../../domain/conversation';
import { getAgent } from '../../domain/agent';
import { createDiscussion, startDiscussion, concludeDiscussion, type DiscussionScenario } from '../../domain/discussion';
import type { AgentRunResult } from '../../../shared/types';
import type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ReviewContext,
} from './file-tools';

// 复用 file-tools.ts 的类型定义（稳定，多处引用）
export type { ToolDefinition, ToolCall, ToolResult, ReviewContext } from './file-tools';

/** 权限守卫：沿用 file-tools.ts 的签名，便于无迁移切换。 */
export type PermissionGuard = (request: {
  action: string;
  path?: string;
  command?: string;
}) => { allowed: boolean; message?: string } | Promise<{ allowed: boolean; message?: string }>;

/** 权限动作枚举：决定 handler 走不走 permissionGuard。 */
export type PermissionAction = 'read-file' | 'write-file' | 'execute-command' | 'network';

/** 工具执行上下文：把原 executeFileTool 的散参收敛成一个对象。 */
export interface ToolContext {
  workingDir: string;
  readonlyDirs: string[];
  /** Agent Bridge loopback（notify_host 用）。 */
  loopback?: { baseUrl: string; taskId: string };
  /** 业务审批上下文（submit_review 用）。 */
  reviewContext?: ReviewContext;
  /** 咨询上下文（ask_colleague 用）：发起咨询的 Task/项目信息。 */
  consultationContext?: {
    db: import('../../db/client').DB;
    askerTaskId: string;
    askerProjectId: string;
    askerProjectTaskId: string;
    askerAgentId: string;
  };
  /** 权限守卫。 */
  permissionGuard?: PermissionGuard;
  /** 注册表自引用，允许 handler 互相调用（如未来工具组合）。 */
  toolRegistry: RuntimeToolRegistry;
}

/** 注册表中的一个运行时工具：定义 + handler + 权限动作 + 来源。 */
export interface RuntimeTool {
  /** OpenAI function calling 格式的工具定义。 */
  definition: ToolDefinition;
  /** 执行 handler：接收 tool call 和上下文，返回结果。 */
  handler: (call: ToolCall, ctx: ToolContext) => Promise<ToolResult>;
  /** 触发权限守卫的动作；undefined 表示不走守卫（如 done/notify）。 */
  permissionAction?: PermissionAction;
  /** 来源标识：哪个 plugin 提供的，便于审计与排错。 */
  source: { pluginId: string; toolName: string };
}

/**
 * 运行时工具注册表。
 * 单实例随 ExecutionContext 注入 tool loop；MCP/自定义工具可在 pumpThread 时
 * 按需 register 进来。
 */
export class RuntimeToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();

  /** 注册一个工具；同名覆盖（后注册者胜，便于 MCP 工具覆盖内置）。 */
  register(tool: RuntimeTool): void {
    this.tools.set(tool.definition.function.name, tool);
  }

  /** 按名字解析工具；未注册返回 undefined。 */
  resolve(name: string): RuntimeTool | undefined {
    return this.tools.get(name);
  }

  /** 列出所有工具定义，用于注入模型 function calling。 */
  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /** 已注册工具数量（测试与诊断用）。 */
  size(): number {
    return this.tools.size;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 内置工具定义（与原 FILE_TOOLS 保持完全一致的行为）
// ──────────────────────────────────────────────────────────────────────────

const MAX_READ_BYTES = 64 * 1024;

function absPath(workingDir: string, rel: string): string {
  return resolve(workingDir, rel);
}

function assertWritable(workingDir: string, readonlyDirs: string[], target: string): void {
  if (!isWithinWorkspace(workingDir, target)) {
    throw new Error(`路径越界：${target} 不在工作目录 ${workingDir} 内`);
  }
  for (const ro of readonlyDirs) {
    if (isWithinWorkspace(ro, target)) {
      throw new Error(`路径只读：${target} 在授权只读目录 ${ro} 内，不可写入`);
    }
  }
}

/** read_file handler。 */
async function readFileHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const rel = String(call.args.path ?? '');
  const target = absPath(ctx.workingDir, rel);
  if (!isWithinWorkspace(ctx.workingDir, target)) {
    return { toolCallId: call.id, name: call.name, content: `错误：路径越界 ${rel}` };
  }
  if (!existsSync(target)) {
    return { toolCallId: call.id, name: call.name, content: `错误：文件不存在 ${rel}` };
  }
  const buf = readFileSync(target);
  const slice = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
  return {
    toolCallId: call.id,
    name: call.name,
    content: slice + (buf.length > MAX_READ_BYTES ? '\n[内容已截断]' : ''),
  };
}

/** write_file handler。 */
async function writeFileHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const rel = String(call.args.path ?? '');
  const content = String(call.args.content ?? '');
  const target = absPath(ctx.workingDir, rel);
  try {
    assertWritable(ctx.workingDir, ctx.readonlyDirs, target);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    return { toolCallId: call.id, name: call.name, content: `已写入 ${rel}（${content.length} 字符）` };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `错误：${(e as Error).message}` };
  }
}

/** edit_file handler。 */
async function editFileHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const rel = String(call.args.path ?? '');
  const oldText = String(call.args.old_text ?? '');
  const newText = String(call.args.new_text ?? '');
  const target = absPath(ctx.workingDir, rel);
  try {
    assertWritable(ctx.workingDir, ctx.readonlyDirs, target);
    if (!existsSync(target)) {
      return { toolCallId: call.id, name: call.name, content: `错误：文件不存在 ${rel}` };
    }
    const original = readFileSync(target, 'utf8');
    const occurrences = original.split(oldText).length - 1;
    if (occurrences === 0) {
      return { toolCallId: call.id, name: call.name, content: `错误：未找到要替换的文本` };
    }
    if (occurrences > 1) {
      return {
        toolCallId: call.id,
        name: call.name,
        content: `错误：要替换的文本匹配 ${occurrences} 处，必须唯一`,
      };
    }
    const updated = original.replace(oldText, newText);
    writeFileSync(target, updated);
    return { toolCallId: call.id, name: call.name, content: `已编辑 ${rel}` };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `错误：${(e as Error).message}` };
  }
}

/** list_files handler。 */
async function listFilesHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const rel = String(call.args.dir ?? '.');
  const target = absPath(ctx.workingDir, rel);
  if (!isWithinWorkspace(ctx.workingDir, target)) {
    return { toolCallId: call.id, name: call.name, content: `错误：路径越界 ${rel}` };
  }
  if (!existsSync(target)) {
    return { toolCallId: call.id, name: call.name, content: `错误：目录不存在 ${rel}` };
  }
  try {
    const entries = readdirSync(target).map((name) => {
      const stat = statSync(path.join(target, name));
      return `${stat.isDirectory() ? '[DIR]' : '     '} ${name}`;
    });
    return {
      toolCallId: call.id,
      name: call.name,
      content: entries.join('\n') || '(空目录)',
    };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `错误：${(e as Error).message}` };
  }
}

/**
 * run_command handler：在工作目录内执行 shell 命令（P1：API 执行器补命令能力）。
 *
 * 安全机制（三重）：
 * 1. 黑名单（sandbox.checkBashCommand）：rm -rf /、mkfs、git push --force 等灾难性命令直接拒绝。
 * 2. permissionGuard（permissionAction='execute-command'）：HIGH_RISK（system-install/git-push/credential-access 等）
 *    自动进审批队列等用户确认。
 * 3. 工作目录隔离：spawn 的 cwd 固定为 ctx.workingDir，命令默认只能在该目录内操作。
 *
 * 不经 shell 解释（spawn 直接调 /bin/sh -c 限定为单条命令字符串，不做管道到第二条命令的注入）。
 * 超时默认 60s，上限 5 分钟；stdout+stderr 截断到 16KB。
 */
async function runCommandHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const command = String(call.args.command ?? '').trim();
  if (!command) {
    return { toolCallId: call.id, name: call.name, content: '错误：command 是必填' };
  }
  // 安全第 1 道：黑名单（灾难性命令硬拒绝）
  const check = checkBashCommand(command, ctx.workingDir);
  if (!check.allowed) {
    return { toolCallId: call.id, name: call.name, content: `错误：命令被拒绝。${check.reason ?? ''}` };
  }
  // 安全第 2 道：风险分级审批。classifyCommand 把命令分为：
  //   run-command（普通）/ git-push / system-install / deploy / credential-access
  // 后四类在 permission.ts 的 HIGH_RISK_ACTIONS 中，会自动进人工审批队列等用户确认。
  if (ctx.permissionGuard) {
    const action = classifyCommand(command);
    const decision = await ctx.permissionGuard({ action, command, path: ctx.workingDir });
    if (!decision.allowed) {
      return {
        toolCallId: call.id,
        name: call.name,
        content: `需要用户审批（${action}）：${decision.message ?? '权限策略未允许此命令'}`,
      };
    }
  }
  const timeoutMs = Math.min(Number(call.args.timeout_ms ?? 60_000) || 60_000, 300_000);
  return new Promise((resolveResult) => {
    // 安全第 3 道：环境变量隔离。剔除 Muster 自身的凭据/数据库路径，
    // 只保留系统 PATH/HOME/LANG 等让命令能跑，但不暴露宿主敏感配置。
    const childEnv = sanitizeChildEnv(process.env);
    const child = spawn('sh', ['-c', command], {
      cwd: ctx.workingDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    const MAX_OUTPUT = 16 * 1024;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8').slice(0, MAX_OUTPUT - stdout.length);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8').slice(0, MAX_OUTPUT - stderr.length);
    });
    child.on('error', (err) => {
      resolveResult({ toolCallId: call.id, name: call.name, content: `命令执行失败：${err.message}` });
    });
    child.on('close', (code) => {
      const truncated = stdout.length >= MAX_OUTPUT ? '\n[stdout 已截断]' : '';
      const errTruncated = stderr.length >= MAX_OUTPUT ? '\n[stderr 已截断]' : '';
      const exitInfo = code === 0 ? '' : `\n[退出码 ${code}]`;
      const combined = `${stdout}${truncated}${stderr ? `\n[stderr]\n${stderr}${errTruncated}` : ''}${exitInfo}`;
      resolveResult({ toolCallId: call.id, name: call.name, content: combined || '(命令无输出)' });
    });
  });
}

/**
 * 子进程环境变量清洗：只保留命令运行必需的变量，剔除宿主敏感配置。
 * 保留 PATH/HOME/USER/LANG/TERM/SHELL/EDITOR 等通用变量；
 * 剔除 API key、token、数据库路径、Muster 内部变量等。
 */
function sanitizeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ALLOW = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'EDITOR', 'VISUAL', 'TMPDIR', 'TZ']);
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // 1. 显式白名单变量
    if (ALLOW.has(key)) { cleaned[key] = value; continue; }
    // 2. 形如 XDG_*、npm_config_*（非含 key/token）的通用配置变量保留
    if (/^(XDG_|npm_config_(?!.*key)color|npm_config_registry|npm_config_cache|npm_config_prefix)/i.test(key)) { cleaned[key] = value; continue; }
    // 3. 其余一律剔除（含 OPENAI_API_KEY / ANTHROPIC_API_KEY / MUSTER_* / *_TOKEN / DATABASE_URL 等）
  }
  return cleaned;
}

/** done handler：解析 AgentRunResult 并标记循环终止。 */
async function doneHandler(call: ToolCall): Promise<ToolResult> {
  const parsed = agentRunResultSchema.safeParse(call.args);
  if (!parsed.success) {
    return {
      toolCallId: call.id,
      name: call.name,
      content: `错误：AgentRunResult 校验失败：${parsed.error.message}`,
    };
  }
  return {
    toolCallId: call.id,
    name: call.name,
    content: 'Task 完成',
    doneResult: parsed.data as AgentRunResult,
  };
}

/** notify_host handler：通过 Agent Bridge 发送进度/通知/预览请求。 */
async function notifyHostHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.loopback) {
    return { toolCallId: call.id, name: call.name, content: '宿主桥接未配置，跳过通知' };
  }
  const action = String(call.args.action ?? 'progress');
  const text = String(call.args.text ?? '');
  const filePath = String(call.args.path ?? '');
  if ((action === 'progress' || action === 'notify') && !text) {
    return {
      toolCallId: call.id,
      name: call.name,
      content: `错误：action=${action} 需要 text 参数`,
    };
  }
  if (action === 'preview' && !filePath) {
    return { toolCallId: call.id, name: call.name, content: '错误：action=preview 需要 path 参数' };
  }
  try {
    const params = new URLSearchParams({ taskId: ctx.loopback.taskId });
    if (action === 'preview' && filePath) {
      params.set('path', filePath);
    } else if (text) {
      params.set('text', text);
    }
    // fire-and-forget HTTP 调用，不阻塞工具循环
    const url = `${ctx.loopback.baseUrl}/bridge/${action}?${params.toString()}`;
    fetch(url).catch(() => {
      /* best-effort */
    });
    return {
      toolCallId: call.id,
      name: call.name,
      content: `已发送${action === 'preview' ? '预览请求' : action === 'notify' ? '通知' : '进度'}：${text || filePath}`,
    };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `通知发送失败：${(e as Error).message}` };
  }
}

/** submit_review handler：提交业务产物审批。 */
async function submitReviewHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.reviewContext) {
    return { toolCallId: call.id, name: call.name, content: '业务审批未配置，跳过提交' };
  }
  try {
    const { db, taskId } = ctx.reviewContext;
    const taskRow = db
      .prepare('SELECT id, project_id, assignee_agent_id FROM task WHERE id=?')
      .get(taskId) as { id: string; project_id: string; assignee_agent_id: string | null } | undefined;
    if (!taskRow) {
      return { toolCallId: call.id, name: call.name, content: `错误：找不到 Task ${taskId}` };
    }
    const projectRow = db
      .prepare('SELECT id, company_id FROM project WHERE id=?')
      .get(taskRow.project_id) as { id: string; company_id: string };
    const reviewKind = String(call.args.review_kind ?? 'custom') as BusinessReviewKind;
    const validKinds: BusinessReviewKind[] = [
      'material',
      'artifact',
      'character',
      'skill',
      'relationship',
      'plot',
      'custom',
    ];
    if (!validKinds.includes(reviewKind)) {
      return {
        toolCallId: call.id,
        name: call.name,
        content: `错误：review_kind 不合法 ${reviewKind}`,
      };
    }
    const review = submitBusinessReview(db, {
      companyId: projectRow.company_id,
      projectId: projectRow.id,
      taskId,
      employeeId: taskRow.assignee_agent_id ?? '',
      reviewKind,
      subjectId: String(call.args.subject_id ?? ''),
      subjectSnapshot: (call.args.snapshot as Record<string, unknown>) ?? {},
      title: String(call.args.title ?? ''),
      summary: call.args.summary ? String(call.args.summary) : undefined,
    });
    return {
      toolCallId: call.id,
      name: call.name,
      content: `已提交业务审批（${reviewKind}）：${review.title}。审批 ID ${review.id}。用户将在审批队列处理；批准后任务继续，打回会派发返工任务。`,
    };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `提交审批失败：${(e as Error).message}` };
  }
}

/**
 * ask_colleague handler（设计二-方案A）：向同事发起结构化咨询。
 *
 * 机制：创建一个咨询型子 Task（assignee=被咨询者），并把当前 Task 标为
 * waiting_dependency（依赖该咨询 Task）。被咨询者完成后系统自动恢复本任务，
 * 回复内容经 task_message（role='dispatch'）注入 recentDiscussion，本任务下次
 * 执行即可看到回复。
 *
 * 这避免了在 tool-loop 内做长阻塞等待（B 忙时 A 会卡住），复用现有依赖恢复机制。
 * handler 返回的 content 提示模型本轮应以 done(waiting_dependency) 收尾。
 */
async function askColleagueHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const cctx = ctx.consultationContext;
  if (!cctx) {
    return { toolCallId: call.id, name: call.name, content: '咨询通道未配置（当前执行器不支持 ask_colleague）' };
  }
  const recipientId = String(call.args.recipient_agent_id ?? '').trim();
  const question = String(call.args.question ?? '').trim();
  if (!recipientId || !question) {
    return { toolCallId: call.id, name: call.name, content: '错误：recipient_agent_id 和 question 都是必填' };
  }
  try {
    const { db, askerTaskId, askerProjectId, askerProjectTaskId, askerAgentId } = cctx;
    // 校验被咨询者存在且同公司
    const asker = getAgent(db, askerAgentId);
    const recipient = getAgent(db, recipientId);
    if (recipient.companyId !== asker.companyId) {
      return { toolCallId: call.id, name: call.name, content: `错误：${recipient.name} 不属于本公司，不能咨询` };
    }
    if (recipient.id === askerAgentId) {
      return { toolCallId: call.id, name: call.name, content: '错误：不能向自己发起咨询' };
    }
    const contextRefs = Array.isArray(call.args.context_refs)
      ? (call.args.context_refs as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : [];
    const consultationTask = createTask(db, {
      projectId: askerProjectId,
      projectTaskId: askerProjectTaskId,
      parentTaskId: askerTaskId,
      dispatcherAgentId: askerAgentId,
      assigneeAgentId: recipientId,
      title: `咨询：${question.slice(0, 40)}${question.length > 40 ? '…' : ''}`,
      inputProtocol: {
        consultation: true,
        lightweight: true, // 轻量化：只注入身份/职责/议题，跳过素材/技能/记忆等大段上下文
        askerTaskId,
        askerAgentId,
        askerAgentName: asker.name,
        question,
        contextRefs,
        // 咨询任务的工作方式提示
        instruction: `同事 ${asker.name} 向你咨询以下问题，请基于你的职责和专业给出简洁明确的回复，回复写在 done 工具的 summary 字段里。`,
      },
      priority: 6, // 咨询任务较高优先级
      isConsultation: true, // 跳过 contactAllow（同事咨询属正常协作）
    });
    // 建立依赖：当前 Task 等待咨询 Task 完成后恢复
    addDependency(db, askerTaskId, consultationTask.id);
    return {
      toolCallId: call.id,
      name: call.name,
      content: `已向 ${recipient.name}（${recipient.role}）发起咨询（Task #${consultationTask.seq}）。本任务将等待对方回复后继续。请立即调用 done 工具，outcome=waiting_dependency，summary 简述你在等待谁的回复。`,
    };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `发起咨询失败：${(e as Error).message}` };
  }
}

/**
 * notify_colleague handler（轻量化-3）：单向告知，不建 task、不阻塞、无需回复。
 * 消息写入对方 task_message（role='dispatch'），对方下次执行时 recentDiscussion 自动注入。
 */
async function notifyColleagueHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const cctx = ctx.consultationContext;
  if (!cctx) {
    return { toolCallId: call.id, name: call.name, content: '通知通道未配置（当前执行器不支持 notify_colleague）' };
  }
  const recipientId = String(call.args.recipient_agent_id ?? '').trim();
  const message = String(call.args.message ?? '').trim();
  if (!recipientId || !message) {
    return { toolCallId: call.id, name: call.name, content: '错误：recipient_agent_id 和 message 都是必填' };
  }
  try {
    const { db, askerTaskId, askerAgentId } = cctx;
    const asker = getAgent(db, askerAgentId);
    const recipient = getAgent(db, recipientId);
    if (recipient.companyId !== asker.companyId) {
      return { toolCallId: call.id, name: call.name, content: `错误：${recipient.name} 不属于本公司，不能通知` };
    }
    // 写入接收方自己（或最近活跃 task）的讨论记录 —— 接收方下次执行时可见
    const recipientRecentTask = db.prepare(
      "SELECT id FROM task WHERE assignee_agent_id=? AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','waiting_approval','paused','blocked') ORDER BY created_at DESC LIMIT 1",
    ).get(recipientId) as { id: string } | undefined;
    if (recipientRecentTask) {
      addTaskMessage(db, recipientRecentTask.id, {
        author: askerAgentId,
        role: 'dispatch',
        content: `[通知] ${message}`,
      });
    } else {
      // 接收方当前无活跃 task：通知暂存到其最近 task 的讨论记录（避免丢失）
      const recentAny = db.prepare(
        "SELECT id FROM task WHERE assignee_agent_id=? ORDER BY created_at DESC LIMIT 1",
      ).get(recipientId) as { id: string } | undefined;
      if (recentAny) {
        addTaskMessage(db, recentAny.id, { author: askerAgentId, role: 'dispatch', content: `[通知] ${message}` });
      } else {
        // 接收方从未有过 task（新员工）：通知写入公司对话流（scope=company，用户可见），保证不丢
        const projectRow = db.prepare('SELECT company_id FROM project WHERE id=?').get(cctx.askerProjectId) as { company_id: string } | undefined;
        if (projectRow) {
          postSystemMessage(db, {
            scopeKind: 'company',
            scopeId: projectRow.company_id,
            role: 'system',
            author: askerAgentId,
            content: `[员工通知] ${asker.name} → ${recipient.name}：${message}`,
          });
        }
      }
    }
    void askerTaskId;
    return {
      toolCallId: call.id,
      name: call.name,
      content: `已通知 ${recipient.name}（${recipient.role}）：${message.slice(0, 60)}${message.length > 60 ? '…' : ''}`,
    };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `发送通知失败：${(e as Error).message}` };
  }
}

/**
 * start_discussion handler（设计二-方案B）：发起多人讨论室。
 * 创建讨论室 + 注册参与者 + 立即启动第一轮发言 + 把当前任务标为依赖第一轮发言任务。
 */
async function startDiscussionHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const cctx = ctx.consultationContext;
  if (!cctx) {
    return { toolCallId: call.id, name: call.name, content: '讨论通道未配置（当前执行器不支持 start_discussion）' };
  }
  const topic = String(call.args.topic ?? '').trim();
  const participantIds = Array.isArray(call.args.participant_agent_ids)
    ? (call.args.participant_agent_ids as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  if (!topic || participantIds.length < 2) {
    return { toolCallId: call.id, name: call.name, content: '错误：topic 必填，participant_agent_ids 至少 2 人' };
  }
  try {
    const { db, askerTaskId, askerProjectId, askerAgentId } = cctx;
    // 确保发起者在参与者列表首位（作为 moderator）
    const ordered = participantIds.includes(askerAgentId)
      ? [askerAgentId, ...participantIds.filter((id) => id !== askerAgentId)]
      : [askerAgentId, ...participantIds];
    const context = (call.args.context && typeof call.args.context === 'object') ? call.args.context as Record<string, unknown> : {};
    const maxTurns = typeof call.args.max_turns === 'number' ? Math.min(Math.max(call.args.max_turns, 2), 24) : 12;
    const scenario = typeof call.args.scenario === 'string' ? call.args.scenario as DiscussionScenario : 'help-request';
    const disc = createDiscussion(db, {
      projectId: askerProjectId,
      topic,
      participantAgentIds: ordered,
      initiatorAgentId: askerAgentId,
      context,
      maxTurns,
      sourceTaskId: askerTaskId,
      scenario,
    });
    // 启动第一轮发言
    const started = startDiscussion(db, disc.id);
    // 当前任务等待第一轮发言完成（以便发起者后续可 conclude）
    addDependency(db, askerTaskId, started.turnTaskId);
    return {
      toolCallId: call.id,
      name: call.name,
      content: `已创建讨论室"${topic}"（${ordered.length} 人参与：${ordered.join('、')}），已启动第一轮发言。讨论 ID：${disc.id}。参与者将轮流发言。请立即调用 done 工具，outcome=waiting_dependency。等讨论有进展后，作为 moderator 你可用 conclude_discussion 工具总结（或继续观察讨论自行演进）。`,
    };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `发起讨论失败：${(e as Error).message}` };
  }
}

/**
 * conclude_discussion handler（设计二-方案B）：总结讨论室。
 * 写纪要 + 结论要点 + 派发实施任务 + 写项目对话窗口。
 */
async function concludeDiscussionHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const cctx = ctx.consultationContext;
  if (!cctx) {
    return { toolCallId: call.id, name: call.name, content: '讨论通道未配置（当前执行器不支持 conclude_discussion）' };
  }
  const discussionId = String(call.args.discussion_id ?? '').trim();
  const minutes = String(call.args.minutes ?? '').trim();
  const keyPoints = Array.isArray(call.args.key_points)
    ? (call.args.key_points as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  if (!discussionId || !minutes || keyPoints.length === 0) {
    return { toolCallId: call.id, name: call.name, content: '错误：discussion_id、minutes、key_points 都是必填' };
  }
  try {
    const { db, askerAgentId } = cctx;
    const actions = Array.isArray(call.args.actions)
      ? (call.args.actions as Array<Record<string, unknown>>).map((a) => ({
          title: String(a.title ?? ''),
          assigneeAgentId: typeof a.assignee_agent_id === 'string' ? a.assignee_agent_id : undefined,
          payload: (a.payload && typeof a.payload === 'object') ? a.payload as Record<string, unknown> : undefined,
        })).filter((a) => a.title)
      : [];
    const memoryNotes = Array.isArray(call.args.memory_notes)
      ? (call.args.memory_notes as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : [];
    const needsHuman = Boolean(call.args.needs_human);
    const result = concludeDiscussion(db, discussionId, {
      minutes,
      conclusion: { keyPoints, actions, memoryNotes },
      concludedByAgentId: askerAgentId,
      needsHuman,
    });
    const humanNote = needsHuman ? ' 已标记需人工确认，参与者已回到各自岗位。' : '';
    const actionInfo = result.dispatchedTaskIds.length ? ` 已派发 ${result.dispatchedTaskIds.length} 个实施任务。` : '';
    return {
      toolCallId: call.id,
      name: call.name,
      content: `讨论"${result.discussion.topic}"已总结。纪要已写入项目对话窗口供用户审阅。${actionInfo}${humanNote}请继续你的原任务（调用 done 工具返回结果）。`,
    };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `总结讨论失败：${(e as Error).message}` };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 内置工具定义（OpenAI function calling 格式，与原 FILE_TOOLS 一致）
// ──────────────────────────────────────────────────────────────────────────

/** 内置工具的 function 定义。行为稳定，从 file-tools.ts 平移。 */
const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'notify_host',
      description:
        '向宿主发送进度通知。用于长任务中报告当前进展，让用户实时了解状态。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['progress', 'notify', 'preview'],
            description: 'progress=进度更新, notify=toast通知, preview=请求预览文件',
          },
          text: {
            type: 'string',
            description: '进度消息或通知文本（action=progress/notify 时必填）',
          },
          path: {
            type: 'string',
            description: '要预览的文件路径（action=preview 时必填）',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_review',
      description:
        '提交业务产物（素材/成品/人物档案/功法/人物关系/剧情）等待用户人工审批。用于产出关键内容后请求确认是否达标。提交后根据公司审批模式，当前 Task 会阻塞等待（blocking）或继续执行（parallel）。',
      parameters: {
        type: 'object',
        properties: {
          review_kind: {
            type: 'string',
            enum: ['material', 'artifact', 'character', 'skill', 'relationship', 'plot', 'custom'],
            description:
              '产物类型：material=素材, artifact=成品, character=人物, skill=功法/技能, relationship=人物关系, plot=剧情, custom=自定义',
          },
          subject_id: {
            type: 'string',
            description: '被审对象的唯一标识（如人物档案 id、素材 id、文件路径等）',
          },
          title: { type: 'string', description: '审批标题（如：人物档案：林某某、第一章初稿）' },
          summary: { type: 'string', description: '一句话摘要，便于用户快速判断' },
          snapshot: {
            type: 'object',
            description:
              '产物快照（审批时的内容副本，防止后续被改）。结构随 review_kind 变化：character 含 name/age/background/appearance/traits；skill 含 name/level/description/effects；relationship 含 characters/edges；plot 含 title/mainline/foreshadowing/conflicts；material/artifact 含 path/format/content。',
          },
        },
        required: ['review_kind', 'subject_id', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取 worktree 内的文件内容。path 相对于工作目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对于工作目录的文件路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入文件（覆盖已有或新建）。path 相对于工作目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对于工作目录的文件路径' },
          content: { type: 'string', description: '文件完整内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '精确替换文件中的文本片段。old_text 必须唯一匹配。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对于工作目录的文件路径' },
          old_text: { type: 'string', description: '要被替换的原文（必须唯一匹配）' },
          new_text: { type: 'string', description: '替换后的新文本' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出目录下的文件和子目录。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '相对于工作目录的目录路径，默认为根', default: '.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在工作目录内执行 shell 命令（如 npm test、git status、npx tsc、构建脚本）。命令会经过黑名单与权限审批；危险命令（rm -rf /、mkfs、git push --force 等）会被拒绝。命令以非交互方式运行，有超时限制。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令（在工作目录内运行）' },
          timeout_ms: { type: 'number', description: '可选：超时毫秒数，默认 60000（60 秒），上限 300000（5 分钟）' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_colleague',
      description: '向同事员工发起一次结构化咨询。对方回复后系统会再次派发本任务给你继续。用于请求信息、方案探讨、确认依赖；不要用于派活（派活用 done 的 outboundTasks）。调用后本任务会进入等待依赖状态。',
      parameters: {
        type: 'object',
        properties: {
          recipient_agent_id: { type: 'string', description: '被咨询的员工 id（必须是同公司同事）' },
          question: { type: 'string', description: '咨询内容（尽量具体，可引用文件路径或产物 id）' },
          context_refs: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：供对方只读引用的文件路径（相对于本任务工作目录）',
          },
        },
        required: ['recipient_agent_id', 'question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notify_colleague',
      description: '向同事员工发送一条单向告知消息（无需对方回复），如"我已完成 XX 的初稿，你可以开始评审了"。消息会写入对方的讨论记录，对方下次执行时可见。不建任务、不阻塞、等待对方空闲时处理。不要用于需要回复的咨询（用 ask_colleague）。',
      parameters: {
        type: 'object',
        properties: {
          recipient_agent_id: { type: 'string', description: '被通知的员工 id（必须是同公司同事）' },
          message: { type: 'string', description: '告知内容（简明，对方无需回复）' },
        },
        required: ['recipient_agent_id', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_discussion',
      description: '发起多人讨论室（设计二-方案B）。参与者按顺序轮流发言（用分身参与，不阻塞主任务）。7 种场景：help-request（难题求助）/task-clarification（任务澄清）/quality-review（质量评审）/task-breakdown（任务细分）/standard-alignment（标准对齐）/conflict-resolution（冲突协调）/brainstorm（头脑风暴）。讨论结束后由发起者调用 conclude_discussion 总结。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '讨论主题（一句话）' },
          participant_agent_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '参与者 id 列表（2-8 人，第一个通常是发起者/moderator，按顺序决定发言轮转）',
          },
          scenario: {
            type: 'string',
            enum: ['help-request', 'task-clarification', 'quality-review', 'task-breakdown', 'standard-alignment', 'conflict-resolution', 'brainstorm'],
            description: '讨论场景，决定结论落地方式。默认 help-request。',
          },
          context: { type: 'object', description: '可选：讨论背景信息（注入给每个发言者）' },
          max_turns: { type: 'number', description: '可选：最大发言轮次，默认 12' },
        },
        required: ['topic', 'participant_agent_ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'conclude_discussion',
      description: '总结讨论室（设计二-方案B）。写纪要 + 结论要点 + 落地动作。结论可派发实施任务（actions）、写项目记忆（memoryNotes）。调用后讨论室关闭，纪要写入项目对话窗口供用户审阅。',
      parameters: {
        type: 'object',
        properties: {
          discussion_id: { type: 'string', description: '讨论室 id（来自 start_discussion 返回）' },
          minutes: { type: 'string', description: '纪要（人话总结讨论过程与各方观点）' },
          key_points: {
            type: 'array',
            items: { type: 'string' },
            description: '结论要点（达成共识或保留分歧的关键点）',
          },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '实施任务标题' },
                assignee_agent_id: { type: 'string', description: '可选：指派给谁' },
                payload: { type: 'object', description: '可选：任务上下文' },
              },
            },
            description: '可选：要派发的实施任务',
          },
          memory_notes: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：要写入项目记忆的要点',
          },
          needs_human: {
            type: 'boolean',
            description: '可选：无结果或需人工参与时设为 true。不派实施 task，写提示让用户确认，参与者分身释放回岗位。',
          },
        },
        required: ['discussion_id', 'minutes', 'key_points'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: '完成 Task，返回 AgentRunResult 结构。调用此工具后工具循环结束。',
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: ['completed', 'waiting_input', 'waiting_dependency', 'blocked'],
            description: 'Task 执行结果状态',
          },
          summary: { type: 'string', description: '简明进展与结论' },
          question: { type: 'string', description: 'outcome=waiting_input 时向派发者追问的问题' },
          outboundTasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                recipientAgentId: { type: 'string' },
                protocolId: { type: 'string' },
                title: { type: 'string' },
                payload: { type: 'object' },
                priority: { type: 'number' },
              },
            },
          },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                kind: { type: 'string' },
                operation: { type: 'string', enum: ['create', 'update', 'delete'] },
              },
            },
          },
          workflowNextEdgeLabel: { type: 'string' },
        },
        required: ['outcome', 'summary'],
      },
    },
  },
];

function defByName(name: string): ToolDefinition {
  const d = BUILTIN_TOOL_DEFINITIONS.find((t) => t.function.name === name);
  if (!d) throw new Error(`内置工具定义缺失：${name}`);
  return d;
}

/** Plugin ID 标识内置工具来源（B3 接入 Plugin 模型后会被真实 pluginId 取代）。 */
const BUILTIN_PLUGIN_ID = '__builtin__';

/**
 * 创建一个注册了 7 个内置工具的注册表。
 * 行为与原 file-tools.ts 的 FILE_TOOLS + executeFileTool switch 完全一致。
 */
export function createBuiltinToolRegistry(): RuntimeToolRegistry {
  const registry = new RuntimeToolRegistry();
  registry.register({
    definition: defByName('read_file'),
    handler: readFileHandler,
    permissionAction: 'read-file',
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'read_file' },
  });
  registry.register({
    definition: defByName('write_file'),
    handler: writeFileHandler,
    permissionAction: 'write-file',
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'write_file' },
  });
  registry.register({
    definition: defByName('edit_file'),
    handler: editFileHandler,
    permissionAction: 'write-file',
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'edit_file' },
  });
  registry.register({
    definition: defByName('list_files'),
    handler: listFilesHandler,
    permissionAction: 'read-file',
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'list_files' },
  });
  registry.register({
    definition: defByName('run_command'),
    handler: runCommandHandler,
    // permissionAction 不固定：handler 内部用 classifyCommand 把命令分到
    // run-command/system-install/git-push/deploy/credential-access 等动作，
    // 其中后四类是 HIGH_RISK，会自动进人工审批队列。
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'run_command' },
  });
  registry.register({
    definition: defByName('done'),
    handler: doneHandler,
    // done 不涉及文件/网络，不走 permissionGuard
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'done' },
  });
  registry.register({
    definition: defByName('notify_host'),
    handler: notifyHostHandler,
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'notify_host' },
  });
  registry.register({
    definition: defByName('submit_review'),
    handler: submitReviewHandler,
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'submit_review' },
  });
  registry.register({
    definition: defByName('ask_colleague'),
    handler: askColleagueHandler,
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'ask_colleague' },
  });
  registry.register({
    definition: defByName('notify_colleague'),
    handler: notifyColleagueHandler,
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'notify_colleague' },
  });
  registry.register({
    definition: defByName('start_discussion'),
    handler: startDiscussionHandler,
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'start_discussion' },
  });
  registry.register({
    definition: defByName('conclude_discussion'),
    handler: concludeDiscussionHandler,
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'conclude_discussion' },
  });
  return registry;
}

// ──────────────────────────────────────────────────────────────────────────
// 统一分发入口（替代原 executeFileTool 的 switch）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 执行单个工具调用：查注册表分发。
 * 沿用原 file-tools.ts 的安全不变量：
 * - 文件类工具先过 permissionGuard（read-file/write-file）
 * - 路径越界/只读由各 handler 内部用 isWithinWorkspace 校验
 * - 未注册工具返回「未知工具」（对齐原 default 分支）
 */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const tool = ctx.toolRegistry.resolve(call.name);
  if (!tool) {
    return { toolCallId: call.id, name: call.name, content: `错误：未知工具 ${call.name}` };
  }

  // 权限守卫：与原 executeFileTool 的 permissionAction 逻辑一致
  if (tool.permissionAction && ctx.permissionGuard) {
    // run_command 按 command 字符串走守卫（HIGH_RISK 如 git-push/system-install 自动进审批）
    if (tool.permissionAction === 'execute-command') {
      const cmd = String(call.args.command ?? '');
      const decision = await ctx.permissionGuard({ action: tool.permissionAction, command: cmd, path: ctx.workingDir });
      if (!decision.allowed) {
        return {
          toolCallId: call.id,
          name: call.name,
          content: `需要用户审批：${decision.message ?? '权限策略未允许此命令执行'}`,
        };
      }
    } else {
      const rel = String(call.args.path ?? call.args.dir ?? '.');
      const target = absPath(ctx.workingDir, rel);
      const decision = await ctx.permissionGuard({ action: tool.permissionAction, path: target });
      if (!decision.allowed) {
        return {
          toolCallId: call.id,
          name: call.name,
          content: `需要用户审批：${decision.message ?? '权限策略未允许此操作'}`,
        };
      }
    }
  }

  return tool.handler(call, ctx);
}
