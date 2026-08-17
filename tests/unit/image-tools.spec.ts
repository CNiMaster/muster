/**
 * WP10 多模态工具化：内置图像生成（image-tools）单元测试。
 *
 * 验证：/images/generations 请求形态（b64/url 双响应）、错误透传、
 * handler 落盘 worktree + 路径穿越拒绝 + 未配置凭据的友好报错。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestImageGeneration, imageGenerateHandler } from '../../src/server/executors/tools/image-tools';
import type { ToolCall } from '../../src/server/executors/tools/file-tools';

const call = (args: Record<string, unknown>): ToolCall => ({ id: 'tc_1', name: 'image_generate', args });

describe('requestImageGeneration', () => {
  it('b64_json 响应解析；请求体含 model/prompt/size', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('gpt-image-1');
      expect(body.prompt).toBe('一只猫');
      expect(body.size).toBe('1024x1024');
      return new Response(JSON.stringify({ data: [{ b64_json: 'aGk=' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await requestImageGeneration({ baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-1', fetchImpl }, '一只猫', '1024x1024');
    expect(result.b64).toBe('aGk=');
  });

  it('url-only 响应解析', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.com/x.png' }] }), { status: 200 })) as unknown as typeof fetch;
    const result = await requestImageGeneration({ baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm', fetchImpl }, 'p', '1024x1024');
    expect(result.url).toBe('https://cdn.example.com/x.png');
  });

  it('非 2xx 抛错并带状态码与片段', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 })) as unknown as typeof fetch;
    await expect(requestImageGeneration({ baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm', fetchImpl }, 'p', '1024x1024'))
      .rejects.toThrow('429');
  });
});

describe('imageGenerateHandler', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'muster-img-'));
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });
  afterAllCleanup();

  function afterAllCleanup(): void {
    process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
  }

  it('未配置 OPENAI_API_KEY → 友好报错（不抛）', async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await imageGenerateHandler(call({ prompt: 'x' }), { workingDir: tmp });
    expect(result.content).toContain('OPENAI_API_KEY');
  });

  it('成功生成 → 落盘 worktree 并返回相对路径；文件名自动补 .png', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }] }), { status: 200 })));
    const result = await imageGenerateHandler(call({ prompt: '封面', filename: 'covers/ch1' }), { workingDir: tmp });
    expect(result.content).toContain('covers/ch1.png');
    expect(existsSync(path.join(tmp, 'covers/ch1.png'))).toBe(true);
    expect(readFileSync(path.join(tmp, 'covers/ch1.png'), 'utf8')).toBe('png-bytes');
  });

  it('路径穿越文件名被净化为工作目录内安全名（不逃出 workingDir）', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: 'aGk=' }] }), { status: 200 })));
    const result = await imageGenerateHandler(call({ prompt: 'x', filename: '../../evil' }), { workingDir: tmp });
    expect(result.content).toContain('图片已生成并保存');
    expect(result.content).not.toContain('..');
    expect(existsSync(path.join(tmp, '../evil'))).toBe(false);
  });
});
