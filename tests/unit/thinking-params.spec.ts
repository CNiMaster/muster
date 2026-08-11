import { describe, expect, it } from 'vitest';
import {
  normalizeThinkingDepth,
  normalizeContextCache,
  thinkingSupportedByModel,
  buildThinkingParams,
} from '../../src/server/domain/thinking-params';

describe('normalizeThinkingDepth / normalizeContextCache', () => {
  it('合法值透传，非法值回退默认', () => {
    expect(normalizeThinkingDepth('high')).toBe('high');
    expect(normalizeThinkingDepth('bogus')).toBe('off');
    expect(normalizeThinkingDepth(undefined)).toBe('off');
    expect(normalizeContextCache('on')).toBe('on');
    expect(normalizeContextCache('bogus')).toBe('auto');
  });
});

describe('thinkingSupportedByModel（自动识别启发式）', () => {
  it('openai o 系列 / reasoning 模型支持', () => {
    expect(thinkingSupportedByModel('openai', 'o3-mini')).toBe(true);
    expect(thinkingSupportedByModel('openai', 'o1-preview')).toBe(true);
    expect(thinkingSupportedByModel('openai', 'gpt-reasoning-pro')).toBe(true);
    expect(thinkingSupportedByModel('openai', 'gpt-4o')).toBe(false);
  });
  it('gemini thinking 模型支持，其余不支持', () => {
    expect(thinkingSupportedByModel('gemini', 'gemini-2.5-thinking-flash')).toBe(true);
    expect(thinkingSupportedByModel('gemini', 'gemini-2.0-flash')).toBe(false);
  });
  it('未知 provider 保守返回 false', () => {
    expect(thinkingSupportedByModel('claude-cli', 'sonnet')).toBe(false);
  });
});

describe('buildThinkingParams（归一化 → provider 参数翻译）', () => {
  it('off 不产生请求参数', () => {
    expect(buildThinkingParams('openai', 'off', 'auto').applied).toBe(false);
    expect(buildThinkingParams('gemini', 'off', 'auto').applied).toBe(false);
  });
  it('openai 翻译为 reasoning_effort', () => {
    const r = buildThinkingParams('openai', 'high', 'auto');
    expect(r.applied).toBe(true);
    expect(r.extraBody).toEqual({ reasoning_effort: 'high' });
  });
  it('gemini 翻译为 thinkingConfig.thinkingBudget（按档位映射）', () => {
    const r = buildThinkingParams('gemini', 'medium', 'on');
    expect(r.applied).toBe(true);
    expect(r.extraBody).toEqual({ generationConfig: { thinkingConfig: { thinkingBudget: 4096 } } });
    expect(buildThinkingParams('gemini', 'low', 'auto').extraBody).toEqual({
      generationConfig: { thinkingConfig: { thinkingBudget: 1024 } },
    });
  });
});
