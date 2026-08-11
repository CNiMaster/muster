import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '../../src/shared/errors';
import {
  classifyFailureCategory,
  isRecoverableSessionError,
  type FailureCategory,
} from '../../src/shared/retry-policy';

/** 构造带显式 failureCategory 标签的错误（模拟 adapter 侧结构化抛错）。 */
function tagged(category: FailureCategory, message = 'tagged'): unknown {
  return Object.assign(new Error(message), { failureCategory: category });
}

describe('classifyFailureCategory', () => {
  it('显式 adapter 标签优先于一切启发式', () => {
    expect(classifyFailureCategory(tagged('capability_gap'))).toBe('capability_gap');
    expect(classifyFailureCategory(tagged('config_error'))).toBe('config_error');
    expect(classifyFailureCategory(tagged('permanent'))).toBe('permanent');
    expect(classifyFailureCategory(tagged('transient'))).toBe('transient');
  });

  it('AppError 的 NO_PROGRESS / BUDGET 判为 permanent', () => {
    expect(classifyFailureCategory(new AppError(ErrorCode.EXECUTOR_NO_PROGRESS, 'no progress'))).toBe('permanent');
    expect(classifyFailureCategory(new AppError(ErrorCode.EXECUTOR_BUDGET_EXCEEDED, 'budget'))).toBe('permanent');
  });

  it('瞬时信号（超时/网络/上下文溢出/进程退出/无输出）判为 transient', () => {
    for (const msg of ['operation timed out', 'network reset', 'context window overflow', 'too many tokens', 'process exited with code 1', 'no output']) {
      expect(classifyFailureCategory(new Error(msg)), msg).toBe('transient');
    }
  });

  it('配置/凭据信号判为 config_error', () => {
    for (const msg of ['unauthorized', 'invalid api key', 'permission denied', '403 forbidden']) {
      expect(classifyFailureCategory(new Error(msg)), msg).toBe('config_error');
    }
  });

  it('能力缺口信号判为 capability_gap', () => {
    for (const msg of ['tool not supported', 'model does not support vision']) {
      expect(classifyFailureCategory(new Error(msg)), msg).toBe('capability_gap');
    }
  });

  it('瞬时优先于能力/配置（避免超时+不支持被误判为不可重试）', () => {
    expect(classifyFailureCategory(new Error('timed out: tool not supported'))).toBe('transient');
  });

  it('完全未知的错误判为 permanent（保持旧"不匹配→不可重试"语义）', () => {
    expect(classifyFailureCategory(new Error('something totally weird'))).toBe('permanent');
    expect(classifyFailureCategory('plain string weirdness')).toBe('permanent');
  });

  it('字符串输入（failTask 传 message）仍按瞬时正则判定', () => {
    expect(classifyFailureCategory('operation timed out')).toBe('transient');
    expect(classifyFailureCategory('permission denied')).toBe('config_error');
  });
});

describe('isRecoverableSessionError', () => {
  it('仅 transient 为 true（其余三类与未知均不重试）', () => {
    expect(isRecoverableSessionError(new Error('operation timed out'))).toBe(true);
    expect(isRecoverableSessionError(new Error('process exited with code 2'))).toBe(true);
    expect(isRecoverableSessionError(tagged('capability_gap'))).toBe(false);
    expect(isRecoverableSessionError(tagged('config_error'))).toBe(false);
    expect(isRecoverableSessionError(tagged('permanent'))).toBe(false);
    expect(isRecoverableSessionError(new Error('something weird'))).toBe(false);
  });

  it('对字符串输入行为兼容旧逻辑', () => {
    expect(isRecoverableSessionError('operation timed out')).toBe(true);
    expect(isRecoverableSessionError('something weird')).toBe(false);
  });
});
