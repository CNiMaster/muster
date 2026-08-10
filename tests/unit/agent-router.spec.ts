/**
 * agent-router tiebreak 单元测试。
 *
 * L-5 修复：同分时按 agent.id 字典序取小，保证路由确定性。
 * tiebreak 逻辑提取为纯函数 shouldReplaceBest，这里覆盖所有分支；
 * 集成测试因 shortId 随机生成无法稳定区分"取第一个"与"取 id 最小"，
 * 故字典序 tiebreak 的正确性在此单元测试中验证。
 */
import { describe, it, expect } from 'vitest';
import { shouldReplaceBest } from '../../src/server/domain/agent-router';

describe('shouldReplaceBest（L-5 tiebreak）', () => {
  it('高分替换低分', () => {
    expect(shouldReplaceBest(10, 'ag_b', 5, 'ag_a')).toBe(true);
  });

  it('低分不替换高分', () => {
    expect(shouldReplaceBest(5, 'ag_a', 10, 'ag_b')).toBe(false);
  });

  it('同分时取 id 字典序较小者（新候选 id 更小 → 替换）', () => {
    expect(shouldReplaceBest(8, 'ag_aaa', 8, 'ag_bbb')).toBe(true);
  });

  it('同分时取 id 字典序较小者（新候选 id 更大 → 不替换）', () => {
    expect(shouldReplaceBest(8, 'ag_bbb', 8, 'ag_aaa')).toBe(false);
  });

  it('同分同 id → 不替换（幂等）', () => {
    expect(shouldReplaceBest(8, 'ag_same', 8, 'ag_same')).toBe(false);
  });
});
