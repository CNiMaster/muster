/**
 * WP10 多模态工具化：内置图像生成 builtin（能力中心=搬运工哲学的落点）。
 *
 * 主模型管思考，画图走工具：任何 chat 模型经 tool-loop 调 image_generate，
 * 由 muster 服务端调 OpenAI 兼容 /images/generations（凭据走 OPENAI_API_KEY 环境变量），
 * 产物落 worktree 文件（可被发布管线带走）。CLI/API 执行器同构可用。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ToolCall, ToolDefinition, ToolResult } from './file-tools';

export const IMAGE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'image_generate',
      description:
        '文生图：按文字描述生成一张图片并保存到工作目录，返回保存路径。用于插画/封面/配图/示意图。需要联网权限与平台图像生成凭据（OPENAI_API_KEY）。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图像描述（主体/风格/构图，尽量具体）' },
          filename: { type: 'string', description: '保存文件名（可含子目录，如 covers/ch1.png；默认自动命名 .png）' },
          size: { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024'], description: '尺寸，默认 1024x1024' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  },
];

/** 文件名 sanitize：只留安全字符，禁止路径穿越。 */
function safeFilename(filename: string | undefined): string {
  const now = new Date();
  const stamp = `${now.getHours()}${now.getMinutes()}${now.getSeconds()}`;
  const raw = (filename ?? '').trim() || `image-${stamp}.png`;
  const normalized = raw.replace(/\\/g, '/').split('/').map((seg) => seg.replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, '')).filter(Boolean).join('/');
  if (!normalized || normalized.includes('..')) return `image-${stamp}.png`;
  return normalized.endsWith('.png') || normalized.endsWith('.jpg') ? normalized : `${normalized}.png`;
}

export interface ImageGenDeps {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 注入 fetch 便于单测。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 调 /images/generations 并返回 b64 或 url。 */
export async function requestImageGeneration(deps: ImageGenDeps, prompt: string, size: string): Promise<{ b64?: string; url?: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 120_000);
  try {
    const res = await doFetch(`${deps.baseURL.replace(/\/+$/, '')}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.apiKey}` },
      body: JSON.stringify({ model: deps.model, prompt, n: 1, size }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`图像生成 API ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const first = data.data?.[0];
    if (!first || (!first.b64_json && !first.url)) throw new Error('图像生成响应为空');
    return { b64: first.b64_json, url: first.url };
  } finally {
    clearTimeout(timer);
  }
}

/** image_generate 工具 handler：生成 → 落盘 worktree → 返回相对路径。 */
export async function imageGenerateHandler(call: ToolCall, ctx: { workingDir: string }): Promise<ToolResult> {
  const prompt = String(call.args.prompt ?? '').trim();
  if (!prompt) return { toolCallId: call.id, name: call.name, content: '错误：prompt 不能为空' };
  const size = ['1024x1024', '1024x1536', '1536x1024'].includes(String(call.args.size ?? '')) ? String(call.args.size) : '1024x1024';

  // 凭据与端点：平台 OpenAI 兼容配置 + OPENAI_API_KEY（与 llm-call 同源，明文只在环境变量）
  const { getDb } = await import('../../db/client');
  const { getSystemSettings } = await import('../../domain/setting');
  let baseURL = 'https://api.openai.com/v1';
  let model = '';
  try {
    const settings = getSystemSettings(getDb());
    baseURL = settings.openaiBaseURL || baseURL;
    model = settings.imageGenModel || 'gpt-image-1';
  } catch { /* 设置读取失败走默认 */ }
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) {
    return { toolCallId: call.id, name: call.name, content: '错误：未配置 OPENAI_API_KEY 环境变量，无法调用图像生成 API（在系统设置/凭据中配置）' };
  }

  try {
    const result = await requestImageGeneration({ baseURL, apiKey, model }, prompt, size);
    let b64 = result.b64;
    if (!b64 && result.url) {
      // provider 回 URL：拉取转存（失败则直接返回 URL 供引用）
      const binary = await fetch(result.url).then((r) => {
        if (!r.ok) throw new Error(`下载生成图失败 HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      b64 = Buffer.from(binary).toString('base64');
    }
    if (!b64) throw new Error('生成结果无图像数据');
    const rel = safeFilename(call.args.filename as string | undefined);
    const abs = path.resolve(ctx.workingDir, rel);
    if (!abs.startsWith(path.resolve(ctx.workingDir))) {
      return { toolCallId: call.id, name: call.name, content: '错误：文件名越界（禁止路径穿越）' };
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(b64, 'base64'));
    return { toolCallId: call.id, name: call.name, content: `图片已生成并保存：${rel}（${size}，模型 ${model}）。可在成果/工作区引用该路径。` };
  } catch (err) {
    return { toolCallId: call.id, name: call.name, content: `图像生成失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
