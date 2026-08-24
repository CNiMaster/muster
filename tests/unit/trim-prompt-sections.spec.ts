/**
 * P1-② 全局软预算守门：trimPromptSections 纯函数单测。
 */
import { describe, expect, it } from 'vitest';
import { trimPromptSections } from '../../src/server/executors/context';

describe('trimPromptSections（systemPrompt 全局软预算）', () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `- 旧档条目 ${i}：${'内'.repeat(50)}`);

  it('不超预算：原样返回', () => {
    const sp = ['# 员工身份', '你是员工', '', '# 相关旧档', ...filler(3), ''];
    expect(trimPromptSections([...sp], 10_000)).toEqual(sp);
  });

  it('超预算：低优先段压缩为段头+省略提示，身份段保留', () => {
    const sp = ['# 员工身份', '你是员工，职责重要', '', '# 相关旧档', ...filler(60), ''];
    const trimmed = trimPromptSections([...sp], 2_000);
    expect(trimmed.join('\n')).toContain('# 员工身份');
    expect(trimmed.join('\n')).toContain('你是员工');
    expect(trimmed.join('\n')).toContain('# 相关旧档');
    expect(trimmed.join('\n')).not.toContain('旧档条目 59');
    expect(trimmed.join('\n')).toContain('已压缩省略');
    expect(trimmed.join('\n').length).toBeLessThan(1_000);
  });

  it('按优先级顺序逐段压缩：旧档先压（预算内即停），素材段完整保留', () => {
    const material = Array.from({ length: 60 }, (_, i) => `- 素材条目 ${i}：${'料'.repeat(50)}`);
    const archive = Array.from({ length: 60 }, (_, i) => `- 旧档条目 ${i}：${'内'.repeat(50)}`);
    const sp = [
      '# 员工身份', '身份正文', '',
      '# 项目素材', ...material, '',
      '# 相关旧档', ...archive, '',
    ];
    const trimmed = trimPromptSections([...sp], 4_500);
    const text = trimmed.join('\n');
    expect(text).not.toContain('旧档条目 59');
    expect(text).toContain('已压缩省略');
    expect(text).toContain('素材条目 59'); // 压完旧档已达标，素材段完整保留
  });

  it('段本来就小（段头+单行）时跳过不压', () => {
    const sp = ['# 相关旧档', '- 只有一条', '# 员工身份', '身份正文'];
    expect(trimPromptSections([...sp], 1)).toEqual(sp);
  });
});
