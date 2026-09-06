/**
 * API 接入模型自动识别（2026-08-31 执行器收口续批）。
 *
 * 背景：模型清单唯一真源是执行器档案 config.models（R5 定案），但清单本身此前只能手填——
 * 服务商下架/新增模型后手填清单会陈旧。本模块从服务商拉取最新可用清单：
 * - OpenAI 兼容：`GET {baseURL}/models`（`data[].id`）
 * - Gemini：`GET {baseURL}/models?key=…`（`models[].name`，只留支持 generateContent 的）
 *
 * Key 消费通道与凭据链一致：优先用本次粘贴值，否则查 `process.env[credentialEnv]`
 * （粘贴 Key 即用的本机 env 热注入已由 local-env 保证）。明文 Key 只进请求头，不落日志。
 * 识别结果交给前端合并：新清单在前，用户手填的额外模型保留（部分网关不回列全部模型）。
 */
import { AppError, ErrorCode } from '../../shared/errors';
import { PROVIDER_DEFAULT_BASE_URL } from '../executors/provider';

/** 拉取超时：识别是表单辅助动作，不宜久等。 */
const DISCOVER_TIMEOUT_MS = 15_000;

/** OpenAI 兼容 /models 响应 → 排序去重后的模型 id 清单。 */
export function parseOpenAiModels(payload: unknown): string[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((item) => (typeof (item as { id?: unknown })?.id === 'string' ? (item as { id: string }).id.trim() : ''))
    .filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** Gemini models.list 响应 → 模型名清单（去掉 `models/` 前缀；有方法标注时只留 generateContent）。 */
export function parseGeminiModels(payload: unknown): string[] {
  const models = (payload as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const names = models
    .map((item) => item as { name?: unknown; supportedGenerationMethods?: unknown })
    .filter((item) => {
      if (typeof item.name !== 'string') return false;
      if (Array.isArray(item.supportedGenerationMethods)) {
        return item.supportedGenerationMethods.includes('generateContent');
      }
      return true;
    })
    .map((item) => (item.name as string).replace(/^models\//, '').trim())
    .filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** 从服务商拉取可用模型清单。provider 与前端 apiKind 对应（openai / gemini）。 */
export async function discoverApiModels(input: {
  provider: 'openai' | 'gemini';
  baseURL?: string;
  credentialEnv?: string;
  keyValue?: string;
}): Promise<{ models: string[] }> {
  const pasted = (input.keyValue ?? '').trim();
  const envName = (input.credentialEnv ?? '').trim();
  const key = pasted || (envName ? process.env[envName] ?? '' : '');
  const baseURL = (input.baseURL ?? '').trim().replace(/\/+$/, '') || PROVIDER_DEFAULT_BASE_URL[input.provider]!;
  const url = input.provider === 'openai' ? `${baseURL}/models` : `${baseURL}/models?pageSize=1000&key=${encodeURIComponent(key)}`;
  if (input.provider === 'gemini' && !key) {
    throw new AppError(ErrorCode.VALIDATION, '请先粘贴 Gemini API Key 再自动识别');
  }
  const headers: Record<string, string> = input.provider === 'openai' && key
    ? { Authorization: `Bearer ${key}` }
    : {};
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS) });
  } catch (error) {
    throw new AppError(ErrorCode.INTERNAL, `连不上服务商（${error instanceof Error ? error.message : String(error)}）；请检查接口地址与本机网络`, { status: 502 });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const hint = response.status === 401 || response.status === 403
      ? 'Key 未设置或无效'
      : response.status === 404
        ? '接口地址可能不对（一般以 /v1 结尾）'
        : '服务商返回错误';
    throw new AppError(ErrorCode.INTERNAL, `自动识别失败：${hint}（HTTP ${response.status}）${body.slice(0, 200)}`, { status: 502 });
  }
  const payload: unknown = await response.json().catch(() => null);
  const models = input.provider === 'openai' ? parseOpenAiModels(payload) : parseGeminiModels(payload);
  return { models };
}
