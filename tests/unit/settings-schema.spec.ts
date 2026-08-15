import { describe, it, expect } from 'vitest';
import { settingsUpdateSchema } from '../../src/server/api/settings';

/**
 * review 修复 C1：swarmRepairMax 曾在 zod 边界被剥掉（zod 默认丢弃未知键），
 * UI 保存永远不生效。此测试锚定 schema 必须放行该键。
 */
describe('settingsUpdateSchema', () => {
  it('放行 swarmRepairMax（六步链的 zod 断点回归）', () => {
    const parsed = settingsUpdateSchema.parse({
      claudeBin: 'claude',
      model: 'm',
      skipPermissions: false,
      timeoutMs: 3000,
      maxToolCalls: 10,
      swarmRepairMax: 7,
    });
    expect(parsed.swarmRepairMax).toBe(7);
  });

  it('越界值被拒绝（1-100）', () => {
    expect(settingsUpdateSchema.safeParse({
      claudeBin: 'claude', model: 'm', skipPermissions: false, timeoutMs: 3000, maxToolCalls: 10,
      swarmRepairMax: 0,
    }).success).toBe(false);
  });
});
