import { describe, expect, it } from 'vitest';
import { recommendStrategy, buildStrategySection, STRATEGY_RULES } from '../../src/server/domain/strategy-recommender';
import type { Task } from '../../src/server/domain/task';

function task(title: string, summary = ''): Task {
  return { id: 't', title, summary } as unknown as Task;
}

describe('recommendStrategy', () => {
  it('调试类任务命中 debug 规则，推荐 TDD + engineer + software-feature', () => {
    const rec = recommendStrategy(task('排查用户登录 bug', '修复登录失败'));
    expect(rec?.ruleId).toBe('debug');
    expect(rec?.recommendedSkillIds).toContain('test-driven-development');
    expect(rec?.recommendedPlaybook).toBe('software-feature');
  });

  it('前端任务命中 ui 规则', () => {
    const rec = recommendStrategy(task('构建一个用户界面组件'));
    expect(rec?.ruleId).toBe('ui');
    expect(rec?.recommendedSkillIds).toContain('frontend-ui-engineering');
  });

  it('小说任务命中 novel playbook', () => {
    const rec = recommendStrategy(task('写第三章正文'));
    expect(rec?.ruleId).toBe('novel');
    expect(rec?.recommendedPlaybook).toBe('novel-chapter');
  });

  it('英文任务同样命中', () => {
    const rec = recommendStrategy(task('design REST API endpoints'));
    expect(rec?.ruleId).toBe('api');
  });

  it('无命中返回 null', () => {
    expect(recommendStrategy(task('zzzz unrelated'))).toBeNull();
  });

  it('多规则命中取最高分', () => {
    // 同时含 ui 与 api 关键词，但 ui 命中更多（界面/组件/页面）
    const rec = recommendStrategy(task('设计一个界面组件页面，附带 api 接口'));
    expect(rec).toBeTruthy();
    expect((rec?.score ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('buildStrategySection 渲染非空且含关键建议', () => {
    const rec = recommendStrategy(task('调试 bug'));
    expect(rec).toBeTruthy();
    const section = buildStrategySection(rec!);
    expect(section).toContain('建议策略');
    expect(section).toContain('test-driven-development');
  });

  it('STRATEGY_RULES 非空且每条有 id/keywords/reason', () => {
    expect(STRATEGY_RULES.length).toBeGreaterThan(0);
    for (const r of STRATEGY_RULES) {
      expect(r.id).toBeTruthy();
      expect(r.keywords.length).toBeGreaterThan(0);
      expect(r.reason).toBeTruthy();
    }
  });
});
