/**
 * 模型定价表（Batch 12）。
 *
 * 用于 OpenAI/Gemini adapter 的成本估算（costUSD）。
 * 单位：USD / 1M tokens（input / output）。
 * 未知模型 cost=0（不阻断，仅记账缺失）。
 *
 * 缓存读取价格通常为正常 input 的 50% 或更低，这里用 input 的 0.5 倍近似。
 */
export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

/** OpenAI 官方 + 兼容厂商常见模型定价（USD/1M tokens）。 */
const PRICING: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-4.1': { inputPer1M: 2, outputPer1M: 8 },
  'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6 },
  'gpt-4-turbo': { inputPer1M: 10, outputPer1M: 30 },
  'gpt-3.5-turbo': { inputPer1M: 0.5, outputPer1M: 1.5 },
  // DeepSeek
  'deepseek-chat': { inputPer1M: 0.14, outputPer1M: 0.28 },
  'deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19 },
  // 通义千问（DashScope）
  'qwen-max': { inputPer1M: 2.8, outputPer1M: 8.4 },
  'qwen-plus': { inputPer1M: 0.4, outputPer1M: 1.2 },
  'qwen-turbo': { inputPer1M: 0.05, outputPer1M: 0.2 },
  // 智谱
  'glm-4': { inputPer1M: 0.1, outputPer1M: 0.1 },
  'glm-4-flash': { inputPer1M: 0.0001, outputPer1M: 0.0001 },
  'glm-4-plus': { inputPer1M: 5, outputPer1M: 5 },
};

/** Gemini 定价（USD/1M tokens）。 */
const GEMINI_PRICING: Record<string, ModelPrice> = {
  'gemini-2.0-flash': { inputPer1M: 0.1, outputPer1M: 0.4 },
  'gemini-2.0-flash-lite': { inputPer1M: 0.075, outputPer1M: 0.3 },
  'gemini-1.5-pro': { inputPer1M: 1.25, outputPer1M: 5 },
  'gemini-1.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
};

/**
 估算成本（USD）。
 - input/output tokens 按 model 定价计算。
 - cachedTokens 按 input 价格的 50%（近似 prompt caching 折扣）。
 - 未知模型返回 0。
 */
export function estimateCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number = 0,
  provider?: 'openai' | 'gemini',
): number {
  const table = provider === 'gemini' ? GEMINI_PRICING : PRICING;
  // 先查精确模型名，再尝试前缀匹配
  let price: ModelPrice | undefined = table[model];
  if (!price) {
    const key = Object.keys(table).find((k) => model.startsWith(k) || k.startsWith(model));
    price = key ? table[key] : undefined;
  }
  if (!price) return 0;
  const inputCost = (inputTokens / 1_000_000) * price.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * price.outputPer1M;
  const cachedCost = (cachedTokens / 1_000_000) * price.inputPer1M * 0.5;
  return inputCost + outputCost + cachedCost;
}
