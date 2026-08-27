/**
 * 选择闭环 S1：skill 画像 typed 读取单测（frontmatter 开放键，name-zh 同模式零解析器改动）。
 */
import { describe, expect, it } from 'vitest';
import { parseSkillProfile } from '../../src/server/domain/capability-profile';

describe('parseSkillProfile', () => {
  it('无任何画像键返回 null（区分"没标"与"标了空"）', () => {
    expect(parseSkillProfile(undefined)).toBeNull();
    expect(parseSkillProfile({})).toBeNull();
    expect(parseSkillProfile({ name: 'x', description: 'y' })).toBeNull();
  });

  it('完整画像：use-cases 切分归一 + 枚举字段', () => {
    const p = parseSkillProfile({
      'use-cases': ' Deliverable, Report ,',
      'output-format': 'file-docx',
      editability: 'medium',
      complexity: 'standard',
    });
    expect(p).toEqual({
      useCases: ['deliverable', 'report'],
      outputFormat: 'file-docx',
      editability: 'medium',
      complexity: 'standard',
    });
  });

  it('枚举值非法视为未标（不抛错）；仅剩合法 use-cases 仍可用', () => {
    const p = parseSkillProfile({ 'use-cases': 'review', editability: 'sometimes', complexity: 'big' });
    expect(p).toEqual({ useCases: ['review'], outputFormat: undefined, editability: undefined, complexity: undefined });
  });

  it('仅 output-format 一个键也构成画像', () => {
    expect(parseSkillProfile({ 'output-format': 'html' })).toEqual({
      useCases: [],
      outputFormat: 'html',
      editability: undefined,
      complexity: undefined,
    });
  });

  it('空 use-cases 字符串不算画像', () => {
    expect(parseSkillProfile({ 'use-cases': ' , ,' })).toBeNull();
  });
});
