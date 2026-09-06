/**
 * API 接入模型自动识别单元测试（2026-08-31 执行器收口续批）。
 *
 * 验证：
 * 1. parseOpenAiModels：data[].id 提取、去重排序、非字符串丢弃
 * 2. parseGeminiModels：models/ 前缀剥离、generateContent 过滤（无方法标注时保留）
 * 3. discoverApiModels：credentialEnv→process.env 取 Key、粘贴 Key 优先、
 *    Gemini 缺 Key 报错、HTTP 401 提示 Key 无效、网络失败给可读错误
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { discoverApiModels, parseOpenAiModels, parseGeminiModels } from '../../src/server/domain/model-discovery';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TEST_DISCOVER_KEY;
});

describe('parseOpenAiModels', () => {
  it('提取 data[].id 并去重排序，丢弃非字符串项', () => {
    expect(parseOpenAiModels({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'a-model' }, { id: 42 }, {}, 'junk'] }))
      .toEqual(['a-model', 'b-model']);
  });
  it('空/畸形载荷返回空清单', () => {
    expect(parseOpenAiModels(null)).toEqual([]);
    expect(parseOpenAiModels({})).toEqual([]);
    expect(parseOpenAiModels({ data: 'nope' })).toEqual([]);
  });
});

describe('parseGeminiModels', () => {
  it('剥离 models/ 前缀，只留支持 generateContent 的模型', () => {
    expect(parseGeminiModels({ models: [
      { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/aqa' },
    ] })).toEqual(['aqa', 'gemini-2.0-flash']);
  });
  it('畸形载荷返回空清单', () => {
    expect(parseGeminiModels(null)).toEqual([]);
    expect(parseGeminiModels({ models: [{ name: 1 }] })).toEqual([]);
  });
});

describe('discoverApiModels', () => {
  it('openai：baseURL+/models，credentialEnv 从进程 env 取 Key 放 Authorization', async () => {
    process.env.TEST_DISCOVER_KEY = 'env-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'm2' }, { id: 'm1' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await discoverApiModels({ provider: 'openai', baseURL: 'https://gw.test/v1/', credentialEnv: 'TEST_DISCOVER_KEY' });
    expect(result.models).toEqual(['m1', 'm2']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gw.test/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer env-key');
  });
  it('粘贴 Key 优先于环境变量；缺 baseURL 时用 provider 默认地址', async () => {
    process.env.TEST_DISCOVER_KEY = 'env-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await discoverApiModels({ provider: 'openai', credentialEnv: 'TEST_DISCOVER_KEY', keyValue: ' pasted-key ' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pasted-key');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.openai.com/v1/models');
  });
  it('gemini：缺 Key 直接报错不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(discoverApiModels({ provider: 'gemini' })).rejects.toThrow('Gemini API Key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('HTTP 401 给 Key 无效提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"bad key"}', { status: 401 })));
    await expect(discoverApiModels({ provider: 'openai', keyValue: 'k' })).rejects.toThrow('Key 未设置或无效');
  });
  it('网络失败给可读错误（不裸抛 fetch 异常）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(discoverApiModels({ provider: 'openai', keyValue: 'k' })).rejects.toThrow('连不上服务商');
  });
});
