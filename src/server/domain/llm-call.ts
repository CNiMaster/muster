/**
 * 平台级 LLM 调用（B3b）。
 *
 * 与执行器（adapter）不同，这是平台自身用的 LLM 调用（如 AI 起草 skill）。
 * 用 OpenAI 兼容 Chat Completions API，复用现有凭据解析（公司覆盖 > 平台默认）。
 * 默认用平台级 credential_definition 中 is_default 的 OpenAI/兼容 key。
 */
import { getSystemSettings } from './setting';
import { listCredentialDefinitions, listCompanyCredentials } from './credential-store';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';

export interface LlmCallOptions {
  /** 系统提示。 */
  system: string;
  /** 用户提示。 */
  user: string;
  /** 模型名，缺省用系统设置默认。 */
  model?: string;
  /** 超时 ms。 */
  timeoutMs?: number;
  /** 公司 id（用于解析公司级凭据覆盖）。 */
  companyId?: string;
}

export interface LlmCallResult {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

/**
 * 调用 LLM 生成文本。
 * 凭据解析顺序：company override > platform default credential_definition > process.env。
 * 未配置任何 OpenAI 兼容 key 时抛 VALIDATION。
 */
export async function callLlm(db: DB, opts: LlmCallOptions): Promise<LlmCallResult> {
  const { apiKey, baseURL, model } = resolveLlmCredential(db, opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AppError(ErrorCode.INTERNAL, `LLM 调用失败 ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return {
      content,
      model,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 LLM 凭据：公司覆盖 > 平台默认 > 环境变量兜底。 */
function resolveLlmCredential(
  db: DB,
  opts: LlmCallOptions,
): { apiKey: string; baseURL: string; model: string } {
  const settings = getSystemSettings(db);
  const baseURL = settings.openaiBaseURL || 'https://api.openai.com/v1';
  const model = opts.model ?? (settings.openaiModel || 'gpt-4o-mini');

  // 1. 公司级覆盖
  if (opts.companyId) {
    const companyCreds = listCompanyCredentials(db, opts.companyId);
    const openaiOverride = companyCreds.find(
      (c) =>
        c.definition.credentialKey === 'OPENAI_API_KEY' ||
        c.definition.applicableExecutors.includes('openai'),
    );
    if (openaiOverride) {
      const envKey = openaiOverride.overrideKey ?? openaiOverride.definition.credentialKey;
      const val = process.env[envKey];
      if (val) return { apiKey: val, baseURL, model };
    }
  }

  // 2. 平台默认 credential_definition
  const defs = listCredentialDefinitions(db, { defaultsOnly: true });
  const openaiDef = defs.find(
    (d) => d.credentialKey === 'OPENAI_API_KEY' || d.applicableExecutors.includes('openai'),
  );
  if (openaiDef) {
    const val = process.env[openaiDef.credentialKey];
    if (val) return { apiKey: val, baseURL, model };
  }

  // 3. 直接环境变量兜底
  if (process.env.OPENAI_API_KEY) {
    return { apiKey: process.env.OPENAI_API_KEY, baseURL, model };
  }

  throw new AppError(
    ErrorCode.VALIDATION,
    '未配置 OpenAI 兼容 LLM 凭据，无法执行 AI 起草。请在凭据中心配置 OPENAI_API_KEY。',
  );
}
