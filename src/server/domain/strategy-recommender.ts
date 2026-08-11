/**
 * 任务策略/方法推荐器（spec 2026-08-12-task-investigation-capability-provisioning B3）。
 *
 * 现状：agent-router 只选「谁」（按 skill 重叠），没有人选「策略」（这是调试 → 上 TDD + 测试工程师）。
 * 本模块按任务形态（标题/摘要关键词）推荐 skill + 角色原型 + playbook，作为低优先级「建议」注入
 * 上下文。映射数据驱动、可扩展，不硬编码进路由。
 *
 * 推荐是建议不是强制：路由仍走 findBestAssignee；策略只是提示。
 */
import type { Task } from './task';

export interface StrategyRule {
  id: string;
  /** 命中关键词（小写匹配，中英文皆可）。 */
  keywords: string[];
  recommendedSkillIds: string[];
  recommendedRole?: string;
  recommendedPlaybook?: string;
  reason: string;
}

export interface StrategyRecommendation {
  ruleId: string;
  recommendedSkillIds: string[];
  recommendedRole?: string;
  recommendedPlaybook?: string;
  reason: string;
  /** 命中关键词数，用于排序/可信度。 */
  score: number;
}

/**
 * 内置策略规则库。覆盖调试/UI/API/小说/图像/视频/社媒/文章几类常见形态。
 * 每条声明它推荐的内建 skill、角色原型与 playbook（均复用既有资产，不新建）。
 */
export const STRATEGY_RULES: StrategyRule[] = [
  { id: 'debug', keywords: ['debug', '调试', 'bug', '修复', '排查', 'fix', '排错'], recommendedSkillIds: ['test-driven-development'], recommendedRole: 'engineer', recommendedPlaybook: 'software-feature', reason: '调试/修复类任务：先写测试复现再改' },
  { id: 'ui', keywords: ['界面', 'ui', 'frontend', '前端', '组件', '页面', '交互'], recommendedSkillIds: ['frontend-ui-engineering'], recommendedRole: 'engineer', recommendedPlaybook: 'software-feature', reason: '前端/UI 类任务：复用 UI 工程 skill' },
  { id: 'api', keywords: ['api', '接口', 'endpoint', '模块边界', 'rest', 'graphql'], recommendedSkillIds: ['api-and-interface-design'], recommendedRole: 'engineer', recommendedPlaybook: 'software-feature', reason: 'API/接口设计类任务：复用接口设计 skill' },
  { id: 'novel', keywords: ['小说', '章节', '正文', '写作', '剧情'], recommendedSkillIds: [], recommendedPlaybook: 'novel-chapter', reason: '小说创作类任务：套用 novel-chapter playbook' },
  { id: 'image', keywords: ['封面', '海报', '插图', 'image', '图片生成'], recommendedSkillIds: [], recommendedPlaybook: 'image-campaign', reason: '图像类任务：套用 image-campaign playbook' },
  { id: 'video', keywords: ['视频', 'video', '短视频', '剪辑'], recommendedSkillIds: [], recommendedPlaybook: 'short-video', reason: '视频类任务：套用 short-video playbook' },
  { id: 'social', keywords: ['社媒', '推文', 'social', '文案', '传播'], recommendedSkillIds: [], recommendedPlaybook: 'social-post', reason: '社媒文案类任务：套用 social-post playbook' },
  { id: 'article', keywords: ['文章', '社论', '编辑', 'article', '约稿'], recommendedSkillIds: [], recommendedPlaybook: 'editorial-article', reason: '编辑/文章类任务：套用 editorial-article playbook' },
];

/**
 * 纯函数：按任务标题+摘要命中关键词为规则打分，返回得分最高者（score>0）。
 * 无命中返回 null。中英文皆走小写子串匹配。
 */
export function recommendStrategy(task: Task, rules: StrategyRule[] = STRATEGY_RULES): StrategyRecommendation | null {
  const text = `${task.title ?? ''} ${(task as Task & { summary?: string }).summary ?? ''}`.toLowerCase();
  if (!text.trim()) return null;
  let best: StrategyRecommendation | null = null;
  for (const rule of rules) {
    let score = 0;
    for (const kw of rule.keywords) {
      if (kw && text.includes(kw.toLowerCase())) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = {
        ruleId: rule.id,
        recommendedSkillIds: rule.recommendedSkillIds,
        recommendedRole: rule.recommendedRole,
        recommendedPlaybook: rule.recommendedPlaybook,
        reason: rule.reason,
        score,
      };
    }
  }
  return best;
}

/** 渲染「建议策略」system prompt 段。 */
export function buildStrategySection(rec: StrategyRecommendation): string {
  const lines = ['', '# 建议策略（预检提示，非强制）', `匹配任务形态：${rec.reason}`];
  if (rec.recommendedSkillIds.length > 0) lines.push(`建议参考 skill：${rec.recommendedSkillIds.join('、')}`);
  if (rec.recommendedRole) lines.push(`建议角色原型：${rec.recommendedRole}`);
  if (rec.recommendedPlaybook) lines.push(`建议 playbook：${rec.recommendedPlaybook}`);
  return lines.join('\n');
}
