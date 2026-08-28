/**
 * 预制蓝图（2026-08-28 用户定案）：蓝图库冷启动为空、唯一来源是自动复盘进化，
 * 新工作台的任务穿不上任何专家（公司层退役时预制模板平台一并删除，小说五岗位失传）。
 * 补 8 套开箱即用打法：软件交付/长篇小说/内容写作/营销推广/调研咨询/视频制作/视觉设计/出版策划。
 *
 * 语义（用户口径）：
 * - 默认 active 参与匹配——建「写一章小说」类任务即自动穿戴班底；
 * - 原版始终保留：进化/优化发生在行本身（工作态），播种时的原版存 preset_snapshot_json；
 * - 蓝图库页可单独重置（resetBlueprint 恢复原版+清战绩）；
 * - 幂等查重按 taskType 精确匹配且含全部状态：用户 retire 后重启不复活；
 * - 与自动进化共存：真实战绩照记、班底照扩，用着用着自然长成自己的打法。
 *
 * taskType 词元设计约束：匹配按 jaccard（≥0.2 阈值），词元多会稀释相似度，
 * 故每套只取 2-4 个高信号词；长标题漏配由 matchBlueprints 的子串包含兜底补。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { commitBlueprintVersion, type BlueprintPresetSnapshot, type BlueprintStaffingSlot } from './blueprint';

export interface BlueprintPresetDef {
  /** 任务类型词元（| 拼接），高信号词 2-4 个。 */
  taskType: string;
  label: string;
  description: string;
  /** 班底：主槽在前（任务穿戴主专家），协作槽随后（注入协作提示）。 */
  staffing: BlueprintStaffingSlot[];
}

export const BLUEPRINT_PRESETS: BlueprintPresetDef[] = [
  {
    taskType: '小说|正文|章节',
    label: '长篇小说创作',
    description: '用于「写一章小说」「修订正文」这类创作活：主笔执笔，主编把控方向与节奏，连续性审校盯设定、时间线与前后文冲突。情节/人物/世界观专家在人设库按需选拔，题材扩展包（科幻/言情/悬疑等）随项目初始化。',
    staffing: [
      { personaId: 'novel/novel-writer', personaName: '小说主笔', role: '执笔' },
      { personaId: 'novel/novel-chief-editor', personaName: '小说主编', role: '方向与节奏' },
      { personaId: 'novel/novel-plot-architect', personaName: '情节架构师', role: '主线与伏笔' },
      { personaId: 'novel/novel-continuity-reviewer', personaName: '连续性审校', role: '一致性检查' },
    ],
  },
  {
    taskType: '软件|开发|代码|修复',
    label: '软件交付',
    description: '用于「开发一个功能」「修复 bug」「重构模块」这类工程活：软件架构师主导设计与实现，前端开发者跟进界面，代码审查员守住合并质量。',
    staffing: [
      { personaId: 'engineering/engineering-software-architect', personaName: '软件架构师', role: '设计与实现' },
      { personaId: 'engineering/engineering-frontend-developer', personaName: '前端开发者', role: '界面实现' },
      { personaId: 'engineering/engineering-code-reviewer', personaName: '代码审查员', role: '质量把关' },
    ],
  },
  {
    taskType: '文章|写作|公众号',
    label: '内容写作',
    description: '用于「写一篇文章」「公众号推文」「稿件打磨」这类内容活：内容创作者主笔成稿，文字编辑优化结构与语言，主编把关选题与质量。',
    staffing: [
      { personaId: 'marketing/marketing-content-creator', personaName: '内容创作者', role: '主笔' },
      { personaId: 'publishing/publishing-copy-editor', personaName: '文字编辑', role: '结构润色' },
      { personaId: 'publishing/publishing-editor-in-chief', personaName: '主编', role: '质量把关' },
    ],
  },
  {
    taskType: '营销|推广|宣传',
    label: '营销推广',
    description: '用于「营销方案」「推广活动」「品牌宣传」这类增长活：增长黑客主导策略与实验，SEO 专家管搜索流量，社交媒体策略师管渠道内容。',
    staffing: [
      { personaId: 'marketing/marketing-growth-hacker', personaName: '增长黑客', role: '策略与实验' },
      { personaId: 'marketing/marketing-seo-specialist', personaName: 'SEO专家', role: '搜索流量' },
      { personaId: 'marketing/marketing-social-media-strategist', personaName: '社交媒体策略师', role: '渠道运营' },
    ],
  },
  {
    taskType: '调研|行业|分析报告',
    label: '调研咨询',
    description: '用于「行业调研」「竞品分析」「写一份分析报告」这类研究活：趋势研究员主导课题与框架，投资研究员做深度拆解，高管摘要师把结论压成一页可决策的摘要。',
    staffing: [
      { personaId: 'product/product-trend-researcher', personaName: '趋势研究员', role: '课题与框架' },
      { personaId: 'data/finance-investment-researcher', personaName: '投资研究员', role: '深度分析' },
      { personaId: 'specialized/support-executive-summary-generator', personaName: '高管摘要师', role: '结论提炼' },
    ],
  },
  {
    taskType: '视频|剪辑|短片',
    label: '视频制作',
    description: '用于「拍一条视频」「剪辑短片」「视频脚本」这类创作活：导演统筹叙事与分镜，编剧出脚本，剪辑师成片。',
    staffing: [
      { personaId: 'video/video-director', personaName: '导演', role: '叙事统筹' },
      { personaId: 'video/video-screenwriter', personaName: '编剧', role: '脚本撰写' },
      { personaId: 'video/video-editor', personaName: '剪辑师', role: '成片剪辑' },
    ],
  },
  {
    taskType: '设计|海报|视觉',
    label: '视觉设计',
    description: '用于「设计一张海报」「品牌视觉」「图标设计」这类设计活：创意总监定调性与方案，平面设计师落地执行。',
    staffing: [
      { personaId: 'visual/visual-creative-director', personaName: '创意总监', role: '创意定调' },
      { personaId: 'visual/visual-graphic-designer', personaName: '平面设计师', role: '落地执行' },
    ],
  },
  {
    taskType: '出版|书稿|选题',
    label: '出版策划',
    description: '用于「出版策划」「书稿整理」「选题论证」这类出版活：主编统筹选题与质量，策划编辑定内容规划，校对员兜底文字差错。',
    staffing: [
      { personaId: 'publishing/publishing-editor-in-chief', personaName: '主编', role: '统筹把关' },
      { personaId: 'publishing/publishing-content-planner', personaName: '策划编辑', role: '内容规划' },
      { personaId: 'publishing/publishing-proofreader', personaName: '校对员', role: '文字校对' },
    ],
  },
];

/**
 * 幂等播种预制蓝图：按 taskType 精确查重（含全部状态——用户 retire 后重启不复活），
 * 不存在才插入（source='preset' + 原版快照），并留版本记录。
 */
export function ensureBlueprintPresets(db: DB): void {
  const now = nowIso();
  for (const preset of BLUEPRINT_PRESETS) {
    const exists = db.prepare('SELECT id FROM blueprint WHERE task_type=?').get(preset.taskType);
    if (exists) continue;
    const id = shortId('bp_');
    const snapshot: BlueprintPresetSnapshot = {
      taskType: preset.taskType,
      label: preset.label,
      description: preset.description,
      staffing: preset.staffing,
      stages: [],
    };
    db.transaction(() => {
      db.prepare(
        `INSERT INTO blueprint (id, task_type, label, description, staffing_json, tools_json,
           source_project_ids_json, wins, losses, rework_total, correction_total, status,
           created_at, updated_at, source, preset_snapshot_json)
         VALUES (?, ?, ?, ?, ?, '[]', '[]', 0, 0, 0, 0, 'active', ?, ?, 'preset', ?)`,
      ).run(
        id, preset.taskType, preset.label, preset.description,
        JSON.stringify(preset.staffing),
        now, now,
        JSON.stringify(snapshot),
      );
      commitBlueprintVersion(db, id, '预制蓝图就位：开箱即用的官方打法，随真实战绩持续进化（原版存快照，可随时重置）', ['preset']);
    })();
  }
}
