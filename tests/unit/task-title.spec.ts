import { describe, expect, it } from 'vitest';
import { clampTaskTitle } from '../../src/server/domain/task-title';

/** 任务标题字数上限（2026-08-23 用户定案）：AI 生成侧 中文 ≤14 字/英文 ≤28 字符（显示宽度 28）。 */
describe('clampTaskTitle', () => {
  it('中文 14 字以内原样保留（仅压空白）', () => {
    expect(clampTaskTitle('修复登录超时')).toBe('修复登录超时');
    expect(clampTaskTitle('  竞品  对比矩阵  ')).toBe('竞品 对比矩阵');
  });

  it('中文超 14 字截断到显示宽度 28', () => {
    const title = '重构任务顶栏显示任务名与项目名和分支名菜单按钮样式的两个菜单';
    const clamped = clampTaskTitle(title);
    expect(Array.from(clamped).length).toBeLessThanOrEqual(14);
    expect(clamped).not.toContain('菜单');
  });

  it('英文 28 字符以内原样保留，超长截断', () => {
    expect(clampTaskTitle('Fix login timeout bug')).toBe('Fix login timeout bug');
    const long = 'Investigate competitor matrix and produce comparison report';
    expect(clampTaskTitle(long).length).toBeLessThanOrEqual(28);
  });

  it('中英混合按显示宽度计（CJK 记 2）', () => {
    // "修复"=4 宽 + 24 个英文字符 = 28 宽：正好不截
    expect(clampTaskTitle('修复' + 'a'.repeat(24))).toBe('修复' + 'a'.repeat(24));
    // 再加一个字符就越界截断
    const over = clampTaskTitle('修复' + 'a'.repeat(25));
    expect(over.length).toBe('修复'.length + 24);
  });

  it('空串与全空白安全', () => {
    expect(clampTaskTitle('')).toBe('');
    expect(clampTaskTitle('   ')).toBe('');
  });
});
