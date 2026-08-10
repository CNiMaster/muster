/**
 * API 型执行器能力探针（设计一：API 能力矩阵）。
 *
 * 连通性探针只验证"能不能回 OK"；能力探针进一步验证模型/供应商的能力等级：
 * 1. functionCalling —— 请求带 tools 时是否返回 tool_calls（很多兼容层不支持或半支持）
 * 2. toolLoop —— 工具结果回填后模型能否消费并继续收敛（工具循环完整性）
 * 3. structuredOutput —— response_format / responseMimeType 是否生效
 * 4. instructionLevel —— 标准指令遵循完成度（用于能力分级与"对供应商有要求"提示）
 *
 * 无副作用：只发 HTTP 请求，不碰文件。
 */
import { PROVIDER_DEFAULT_API_KEY_ENV, PROVIDER_DEFAULT_BASE_URL, PROVIDER_DEFAULT_MODEL, type Provider } from '../executors/provider';
import type { DB } from '../db/client';

/** 读取某执行器档案最新的能力探针结果（无有效结果返回 null）。 */
export function getCapabilityProbeForProfile(db: DB, executorProfileId: string): CapabilityProbeResult | null {
  const row = db
    .prepare(
      `SELECT capability_json FROM connection_probe
       WHERE executor_profile_id=? AND kind='capability' AND status='connected' AND capability_json IS NOT NULL
       ORDER BY completed_at DESC, id DESC LIMIT 1`,
    )
    .get(executorProfileId) as { capability_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.capability_json) as CapabilityProbeResult;
  } catch {
    return null;
  }
}

/**
 * 判定执行器是否具备命令执行能力（阶段二任务 2.3）：
 * - CLI 型天然具备（manifest kind 非 api）。
 * - API 型按能力探针真实结果：function calling + 工具循环完整才算具备；
 *   未探过或探针失败一律视为不具备（保持保守）。
 */
export function hasCommandCapability(
  db: DB,
  executorProfileId: string | null,
  manifestKind: 'cli' | 'api' | undefined,
): boolean {
  if (manifestKind !== 'api') return true;
  if (!executorProfileId) return false;
  const probe = getCapabilityProbeForProfile(db, executorProfileId);
  return Boolean(probe?.functionCalling && probe.toolLoop);
}

export interface CapabilityProbeResult {
  functionCalling: boolean;
  toolLoop: boolean;
  structuredOutput: boolean;
  instructionLevel: 'low' | 'medium' | 'high';
  /** 由探针结果推导：可执行的任务类别。 */
  supportedTasks: string[];
  /** 缺命令执行等：不可执行的任务类别。 */
  unsupportedTasks: string[];
  /** 人话提示（能力边界说明）。 */
  note: string;
}

export interface ApiCapabilityProbeOptions {
  provider: 'openai' | 'gemini';
  baseURL?: string;
  model?: string;
  /** API key 明文值（来自 env 解析，不落库）。 */
  apiKey?: string;
  timeoutMs?: number;
}

const OK = 'MUSTER_CAPABILITY_OK';

const ECHO_TOOL = {
  type: 'function',
  function: {
    name: 'echo',
    description: '返回传入的 payload 内容。',
    parameters: {
      type: 'object',
      properties: { payload: { type: 'string', description: '要原样返回的文本' } },
      required: ['payload'],
    },
  },
};

/** 探针过程中的分类错误（由调用方转 ProbeClassification）。 */
export class ApiProbeError extends Error {
  constructor(
    public classification: 'authentication_failed' | 'model_failed' | 'network_failed' | 'timeout' | 'failed',
    message: string,
  ) { super(message); }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<{ status: number; data: any }> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (error: any) {
    if (error?.name === 'TimeoutError' || /abort/i.test(String(error?.message ?? ''))) {
      throw new ApiProbeError('timeout', '能力探针请求超时');
    }
    throw new ApiProbeError('network_failed', `能力探针网络错误: ${error?.message ?? String(error)}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const lower = text.toLowerCase();
    if (res.status === 401 || res.status === 403 || /auth|unauthorized|invalid.*key/i.test(lower)) {
      throw new ApiProbeError('authentication_failed', `能力探针认证失败 (${res.status}): ${text.slice(0, 200)}`);
    }
    if (res.status === 404 || /model.*(not found|unsupported|access)|invalid.*model/i.test(lower)) {
      throw new ApiProbeError('model_failed', `能力探针模型错误 (${res.status}): ${text.slice(0, 200)}`);
    }
    throw new ApiProbeError('failed', `能力探针请求失败 (${res.status}): ${text.slice(0, 200)}`);
  }
  let data: any;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: res.status, data };
}

/**
 * 对 API 型执行器运行能力探针（openai 兼容 chat/completions 或 gemini generateContent）。
 */
export async function runApiCapabilityProbe(opts: ApiCapabilityProbeOptions): Promise<CapabilityProbeResult> {
  const { provider } = opts;
  const baseURL = (opts.baseURL ?? PROVIDER_DEFAULT_BASE_URL[provider] ?? '').replace(/\/+$/, '');
  const model = opts.model ?? PROVIDER_DEFAULT_MODEL[provider] ?? '';
  const apiKey = opts.apiKey ?? '';
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (!baseURL || !model) {
    throw new ApiProbeError('failed', `能力探针配置不完整：baseURL=${baseURL || '(空)'} model=${model || '(空)'}`);
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const headers: Record<string, string> = provider === 'gemini'
    ? { 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const url = provider === 'gemini'
    ? `${baseURL}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`
    : `${baseURL}/chat/completions`;

  // ===== 1+2. function calling + 工具循环（一次往返） =====
  let functionCalling = false;
  let toolLoop = false;
  try {
    if (provider === 'openai') {
      const messages: any[] = [
        { role: 'user', content: `请调用 echo 工具，payload 传 "hello"，然后把工具返回的 payload 原样回复给我。不要解释，不要调用其他工具。` },
      ];
      const first = await postJson(url, headers, { model, messages, tools: [ECHO_TOOL], tool_choice: 'auto', stream: false }, signal);
      const toolCalls = first.data?.choices?.[0]?.message?.tool_calls;
      functionCalling = Array.isArray(toolCalls) && toolCalls.length > 0;
      if (functionCalling) {
        messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
        messages.push({ role: 'tool', tool_call_id: toolCalls[0].id, content: '"hello"' });
        const second = await postJson(url, headers, { model, messages, tools: [ECHO_TOOL], tool_choice: 'auto', stream: false }, signal);
        const content = String(second.data?.choices?.[0]?.message?.content ?? '');
        toolLoop = content.trim().length > 0;
      }
    } else {
      // gemini：functionCall / functionResponse 格式
      const contents: any[] = [
        { role: 'user', parts: [{ text: `请调用 echo 工具，payload 传 "hello"，然后把工具返回的 payload 原样回复给我。不要解释，不要调用其他工具。` }] },
      ];
      const first = await postJson(url, headers, {
        contents,
        tools: [{ functionDeclarations: [{ name: 'echo', description: '返回传入的 payload 内容。', parameters: { type: 'object', properties: { payload: { type: 'string' } }, required: ['payload'] } }] }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      }, signal);
      const parts = first.data?.candidates?.[0]?.content?.parts ?? [];
      const fc = parts.find((p: any) => p.functionCall);
      functionCalling = Boolean(fc);
      if (functionCalling) {
        const fcName = fc.functionCall.name;
        contents.push({ role: 'model', parts: [{ functionCall: fc.functionCall }] });
        contents.push({ role: 'user', parts: [{ functionResponse: { name: fcName, response: { payload: 'hello' } } }] });
        const second = await postJson(url, headers, { contents }, signal);
        const text = (second.data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
        toolLoop = text.trim().length > 0;
      }
    }
  } catch (error) {
    // 关键：timeout / network / auth / model 错误必须立即上抛（不能被能力矩阵的 catch 吞掉）。
    // 只有"工具参数不支持""400 等业务错误"才降级为 functionCalling=false 继续测其他项。
    if (error instanceof ApiProbeError) throw error;
    functionCalling = false;
    toolLoop = false;
  }

  // ===== 3. 结构化输出 =====
  let structuredOutput = false;
  try {
    if (provider === 'openai') {
      const res = await postJson(url, headers, {
        model,
        messages: [{ role: 'user', content: '只返回 JSON 对象：{"ok":true}，不要其他任何内容。' }],
        response_format: { type: 'json_object' },
      }, signal);
      const content = String(res.data?.choices?.[0]?.message?.content ?? '');
      structuredOutput = (() => { try { const v = JSON.parse(content); return v !== null && typeof v === 'object'; } catch { return false; } })();
    } else {
      const res = await postJson(url, headers, {
        contents: [{ role: 'user', parts: [{ text: '只返回 JSON 对象：{"ok":true}，不要其他任何内容。' }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }, signal);
      const text = (res.data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
      structuredOutput = (() => { try { const v = JSON.parse(text); return v !== null && typeof v === 'object'; } catch { return false; } })();
    }
  } catch {
    structuredOutput = false; // 不支持 response_format 等 → 判定不支持
  }

  // ===== 4. 指令遵循等级 =====
  let instructionLevel: 'low' | 'medium' | 'high' = 'low';
  try {
    let content = '';
    if (provider === 'openai') {
      const res = await postJson(url, headers, {
        model,
        messages: [{ role: 'user', content: `只回复 ${OK}，不要调用工具，不要读取或修改文件。` }],
      }, signal);
      content = String(res.data?.choices?.[0]?.message?.content ?? '');
    } else {
      const res = await postJson(url, headers, {
        contents: [{ role: 'user', parts: [{ text: `只回复 ${OK}，不要调用工具，不要读取或修改文件。` }] }],
      }, signal);
      content = (res.data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    }
    const trimmed = content.trim();
    if (trimmed === OK) instructionLevel = 'high';
    else if (trimmed.includes(OK)) instructionLevel = 'medium';
    else instructionLevel = 'low';
  } catch {
    instructionLevel = 'low';
  }

  // ===== 能力矩阵推导 =====
  const supportedTasks: string[] = ['读写工作目录文件', '进度汇报与业务审批', '任务派发（outboundTasks）'];
  const unsupportedTasks: string[] = ['执行命令（安装依赖 / 运行测试 / 构建）', 'git 操作（commit / push / 分支）', '部署与发布'];
  if (!functionCalling) {
    unsupportedTasks.push('工具调用（函数调用）');
  }
  if (functionCalling && toolLoop) supportedTasks.push('多轮工具调用（文件操作闭环）');
  if (structuredOutput) supportedTasks.push('结构化输出（JSON 约束）');
  const noteParts: string[] = [];
  if (!functionCalling) noteParts.push('不支持 function calling，Muster 的 7 个内置工具无法使用，只能做纯文本问答');
  if (functionCalling && !toolLoop) noteParts.push('支持函数调用但工具结果回填后无法继续收敛，长任务可能中途终止');
  if (!structuredOutput) noteParts.push('不支持结构化输出约束，最终结果可能不是合法 JSON');
  if (instructionLevel === 'low') noteParts.push('指令遵循能力弱，建议换更强模型或连接 CLI');
  // 阶段二任务 2.3：按真实能力推导命令执行结论，不再固定写"无命令执行能力"
  if (functionCalling && toolLoop) {
    noteParts.push('具备命令执行能力（function calling + 工具循环完整），可调用 run_command 在沙盒内执行命令（经过黑名单与权限审批）');
  } else {
    noteParts.push('无命令执行能力：测试 / 构建 / 安装依赖 / git 操作需连接 CLI 执行器（Codex CLI / Claude Code CLI 等）');
  }
  return {
    functionCalling,
    toolLoop,
    structuredOutput,
    instructionLevel,
    supportedTasks,
    unsupportedTasks,
    note: noteParts.join('；'),
  };
}

/** 各 provider 默认的 API key 环境变量名（供探针解析）。 */
export const API_PROBE_DEFAULT_API_KEY_ENV: Partial<Record<Provider, string>> = PROVIDER_DEFAULT_API_KEY_ENV;
