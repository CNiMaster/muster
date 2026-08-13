/**
 * 生成参数归一化（spec 2026-08-12-settings-overhaul-design B3）。
 *
 * 思考深度对外暴露归一化档位（off/low/medium/high），按 provider 翻译成各家参数：
 * - OpenAI 兼容（o 系列）：`reasoning_effort: 'low'|'medium'|'high'`。
 * - Gemini：`generationConfig.thinkingConfig.thinkingBudget`（token 预算映射）。
 * - 不支持的模型：不传任何参数（且 UI 隐藏该设置）。
 *
 * 上下文缓存模式（auto/on/off）：openai 前缀缓存与 gemini 隐式缓存均由服务端自动处理，
 * 当前实现 'on'/'auto' 无额外请求参数（保持默认），'off' 为文档化 no-op——真实禁用需 provider
 * 支持显式开关，留待各家 API 演进后再接。参数只做翻译，不做 provider 未定义行为。
 */

export type ThinkingDepth = 'off' | 'low' | 'medium' | 'high';
export type ContextCacheMode = 'auto' | 'on' | 'off';

export const THINKING_DEPTHS: readonly ThinkingDepth[] = ['off', 'low', 'medium', 'high'];
export const CONTEXT_CACHE_MODES: readonly ContextCacheMode[] = ['auto', 'on', 'off'];

/** 校验并归一化思考深度（非法值回退 off）。 */
export function normalizeThinkingDepth(value: unknown): ThinkingDepth {
  return (THINKING_DEPTHS as readonly unknown[]).includes(value) ? (value as ThinkingDepth) : 'off';
}

/** 校验并归一化上下文缓存模式（非法值回退 auto）。 */
export function normalizeContextCache(value: unknown): ContextCacheMode {
  return (CONTEXT_CACHE_MODES as readonly unknown[]).includes(value) ? (value as ContextCacheMode) : 'auto';
}

/**
 * 启发式判断模型是否支持思考（自动识别）：
 * - openai：o1/o3/o4 系列或模型名含 reasoning。
 * - gemini：模型名含 thinking。
 * 其余 provider/未知模型返回 false（保守，不传思考参数）。
 */
export function thinkingSupportedByModel(provider: string, model: string): boolean {
  const m = model.toLowerCase();
  if (provider === 'openai') {
    return /^o[134]-/.test(m) || m.includes('reasoning');
  }
  if (provider === 'gemini') {
    return m.includes('thinking');
  }
  return false;
}

/** Gemini thinkingBudget 档位映射（token 预算）。 */
const GEMINI_THINKING_BUDGET: Record<Exclude<ThinkingDepth, 'off'>, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
};

export interface ThinkingParams {
  /** 追加到请求体的参数（provider 翻译结果）。 */
  extraBody?: Record<string, unknown>;
  /** 是否实际生效（false 表示不支持/off，调用方不应改 body）。 */
  applied: boolean;
}

/**
 * 翻译归一化思考深度 + 缓存模式 → provider 请求参数。
 * @param provider 'openai' | 'gemini'
 * @param depth 归一化思考深度
 * @param cache 缓存模式（当前为文档化 no-op，保留参数位）
 */
export function buildThinkingParams(provider: 'openai' | 'gemini', depth: ThinkingDepth, cache: ContextCacheMode): ThinkingParams {
  if (depth === 'off') return { applied: false };
  if (provider === 'openai') {
    return { applied: true, extraBody: { reasoning_effort: depth } };
  }
  if (provider === 'gemini') {
    return {
      applied: true,
      extraBody: {
        generationConfig: { thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET[depth] } },
      },
    };
  }
  return { applied: false };
}
