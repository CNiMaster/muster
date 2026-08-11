import { describe, expect, it } from 'vitest';
import { matchSkillsByContent, loadSkillCatalog, type SkillCatalogEntry } from '../../src/server/domain/skill-retrieval';
import path from 'node:path';

const catalog: SkillCatalogEntry[] = [
  { skillId: 'test-driven-development', name: 'test-driven-development', description: 'Write tests first. Use when implementing logic, before writing implementation code.' },
  { skillId: 'api-and-interface-design', name: 'api-and-interface-design', description: 'Guides stable API and interface design. Use when designing APIs or module boundaries.' },
  { skillId: 'frontend-ui-engineering', name: 'frontend-ui-engineering', description: 'Build user interfaces and UI components.' },
];

describe('matchSkillsByContent', () => {
  it('英文任务按词命中相关 skill 并排序', () => {
    const hits = matchSkillsByContent(catalog, 'design a REST API and its module boundaries');
    expect(hits[0]).toBe('api-and-interface-design');
  });

  it('中文任务按 CJK 双字子串命中', () => {
    const cnCatalog: SkillCatalogEntry[] = [
      { skillId: 'ui-skill', name: 'ui-skill', description: '用于构建用户界面、前端组件' },
      { skillId: 'unrelated', name: 'unrelated', description: '数据库备份与恢复' },
    ];
    const hits = matchSkillsByContent(cnCatalog, '请帮我构建一个用户界面');
    expect(hits).toContain('ui-skill');
    expect(hits).not.toContain('unrelated');
  });

  it('无文本或无匹配返回空', () => {
    expect(matchSkillsByContent(catalog, '')).toEqual([]);
    expect(matchSkillsByContent(catalog, 'zzzzz unrelated noise')).toEqual([]);
  });

  it('遵守 limit 上限', () => {
    const hits = matchSkillsByContent(catalog, 'design API interface test logic implementation', 1);
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});

describe('loadSkillCatalog（读取真实 skills/ 库）', () => {
  it('解析 bundled skills 的 frontmatter，含 name/description', () => {
    const root = path.resolve(__dirname, '../../skills');
    const catalog = loadSkillCatalog(root);
    expect(catalog.length).toBeGreaterThan(0);
    const tdd = catalog.find((e) => e.skillId === 'test-driven-development');
    expect(tdd).toBeTruthy();
    expect(tdd?.description.length).toBeGreaterThan(0);
  });
});
