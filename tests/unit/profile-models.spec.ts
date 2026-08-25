/**
 * R5 供应商卡片+模型列表（合并计划 2026-08-25-network-retry-progress-recovery-plan.md）：
 * - profileModels 兼容规范入口：models 优先 / 旧 model 单键包装 / 形状不合规回退
 * - profilePrimaryModel 主模型（所有消费方缺省链统一）
 * - findModelContextWindow 行级窗口
 * - resolveContextWindow 行级优先、档案级兜底、缺省 128k
 */
import { describe, expect, it } from 'vitest';
import { profileModels, profilePrimaryModel, findModelContextWindow } from '../../src/shared/executor';
import { resolveContextWindow, DEFAULT_CONTEXT_WINDOW_TOKENS } from '../../src/server/domain/executor-profile';

describe('profileModels（R5 兼容入口）', () => {
  it('models 优先：过滤空 model 项、保留行级窗口/note；双写时与 model 一致', () => {
    const list = profileModels({
      model: 'primary',
      models: [
        { model: 'gpt-4o', contextWindowTokens: 128_000, note: '主力' },
        { model: '  ', contextWindowTokens: 999 }, // 空 model 项剔除
        { model: 'gpt-4o-mini' },
        '垃圾项' as never,
      ],
    });
    expect(list).toEqual([
      { model: 'gpt-4o', contextWindowTokens: 128_000, note: '主力' },
      { model: 'gpt-4o-mini' },
    ]);
  });

  it('旧档案无 models → config.model 包装单元素数组（trim）', () => {
    expect(profileModels({ model: ' deepseek-chat ' })).toEqual([{ model: 'deepseek-chat' }]);
    expect(profileModels({ model: '' })).toEqual([]);
    expect(profileModels({})).toEqual([]);
    expect(profileModels(null)).toEqual([]);
    expect(profileModels({ models: [] })).toEqual([]);
  });
});

describe('profilePrimaryModel（R5 主模型链）', () => {
  it('models[0]；无 models 回退 model；全空 undefined', () => {
    expect(profilePrimaryModel({ models: [{ model: 'a' }, { model: 'b' }], model: 'ignored' })).toBe('a');
    expect(profilePrimaryModel({ model: 'only' })).toBe('only');
    expect(profilePrimaryModel({ models: [{ model: 'x' }] })).toBe('x');
    expect(profilePrimaryModel({})).toBeUndefined();
  });
});

describe('findModelContextWindow（R5 行级窗口）', () => {
  it('按模型名取行级；不在清单或无行级 → undefined', () => {
    const config = { models: [{ model: 'big', contextWindowTokens: 1_000_000 }, { model: 'small' }] };
    expect(findModelContextWindow(config, 'big')).toBe(1_000_000);
    expect(findModelContextWindow(config, 'small')).toBeUndefined();
    expect(findModelContextWindow(config, 'missing')).toBeUndefined();
    expect(findModelContextWindow(config, undefined)).toBeUndefined();
  });
});

describe('resolveContextWindow（R5 行级优先）', () => {
  it('行级 > 档案级 > 默认 128k；旧调用（只传 profile）行为不变', () => {
    const profile = { contextWindowTokens: 200_000 } as never;
    expect(resolveContextWindow(profile, 1_000_000)).toBe(1_000_000); // 行级优先
    expect(resolveContextWindow(profile, undefined)).toBe(200_000); // 档案级兜底
    expect(resolveContextWindow(profile)).toBe(200_000); // 旧签名兼容
    expect(resolveContextWindow(null, undefined)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(resolveContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(resolveContextWindow(null, 0)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS); // 0/负值不生效
  });
});
