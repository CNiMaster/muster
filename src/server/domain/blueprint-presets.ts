/**
 * 预制蓝图（2026-08-28 用户定案）：蓝图库冷启动为空、唯一来源是自动复盘进化，
 * 新工作台的任务穿不上任何专家（公司层退役时预制模板平台一并删除，小说五岗位失传）。
 * 补 26 套开箱即用打法（2026-08-28 扩）：原有 8 套（软件交付/长篇小说/内容写作/营销推广/调研咨询/视频制作/视觉设计/出版策划）
 * + 新建任务三分类 18 套（日常办公 6 / 代码开发 5 / 设计创意 7，子类型见 src/shared/task-categories.ts）。
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
  // ── 以下 18 套（2026-08-28）：新建任务三分类（日常办公/代码开发/设计创意）子类型专属蓝图。
  // 创建卡点选子类型 = 直接绑定（blueprintId 直通），词元仅作自由标题的兜底匹配。

  // ===== 日常办公 =====
  {
    taskType: '文档|合同|排版',
    label: '文档处理',
    description: '用于「整理一份文档」「起草合同」「排版输出」这类文档活：文档工程师负责生成与格式化，文字编辑优化结构与表达，校对员兜底文字差错。',
    staffing: [
      { personaId: 'specialized/specialized-document-generator', personaName: '文档工程师', role: '生成与格式化' },
      { personaId: 'publishing/publishing-copy-editor', personaName: '文字编辑', role: '结构润色' },
      { personaId: 'publishing/publishing-proofreader', personaName: '校对员', role: '文字校对' },
    ],
  },
  {
    taskType: '财务|记账|发票|报销',
    label: '金融服务',
    description: '用于「记账」「整理发票」「做财务报表」「税务筹划」这类财务活：财务记账员管账目与凭证，财务分析师出报表与解读，税务策略师管合规与优化。',
    staffing: [
      { personaId: 'data/finance-bookkeeper-controller', personaName: '财务记账员', role: '账目与凭证' },
      { personaId: 'data/finance-financial-analyst', personaName: '财务分析师', role: '报表与解读' },
      { personaId: 'data/finance-tax-strategist', personaName: '税务策略师', role: '合规与优化' },
    ],
  },
  {
    taskType: '数据|图表|可视化',
    label: '数据分析及可视化',
    description: '用于「分析这份数据」「画个图表」「做可视化看板」这类数据活：数据工程师清洗与加工数据，分析报告师生成结论，平面设计师把图表呈现到位。',
    staffing: [
      { personaId: 'engineering/engineering-data-engineer', personaName: '数据工程师', role: '清洗与加工' },
      { personaId: 'specialized/support-analytics-reporter', personaName: '分析报告师', role: '结论提炼' },
      { personaId: 'visual/visual-graphic-designer', personaName: '平面设计师', role: '图表呈现' },
    ],
  },
  {
    taskType: '个人|工作台|日程|待办',
    label: '个人工作台',
    description: '用于「安排我的一天」「整理待办」「汇总日程」这类个人效率活：幕僚长统筹优先级，会议助理管日程与纪要，项目管家盯跟进不漏项。',
    staffing: [
      { personaId: 'specialized/specialized-chief-of-staff', personaName: '幕僚长', role: '统筹优先级' },
      { personaId: 'specialized/specialized-meeting-assistant', personaName: '会议助理', role: '日程与纪要' },
      { personaId: 'product/project-management-project-shepherd', personaName: '项目管家', role: '跟进不漏项' },
    ],
  },
  {
    taskType: '幻灯片|演示文稿|汇报',
    label: '幻灯片演示',
    description: '用于「做一份汇报幻灯片」「整理演示文稿」这类汇报活：视觉叙事师搭叙事结构与故事线，排版设计师定版式节奏，平面设计师补配图与图示。',
    staffing: [
      { personaId: 'design/design-visual-storyteller', personaName: '视觉叙事师', role: '叙事结构' },
      { personaId: 'visual/visual-typography-designer', personaName: '排版设计师', role: '版式节奏' },
      { personaId: 'visual/visual-graphic-designer', personaName: '平面设计师', role: '配图图示' },
    ],
  },
  {
    taskType: '产品|需求|PRD',
    label: '产品管理',
    description: '用于「写一份 PRD」「梳理需求」「排产品优先级」这类产品活：产品经理主导需求定义与方案，冲刺排序师管优先级，反馈综合师汇用户声音。',
    staffing: [
      { personaId: 'product/product-manager', personaName: '产品经理', role: '需求定义' },
      { personaId: 'product/product-sprint-prioritizer', personaName: '冲刺排序师', role: '优先级' },
      { personaId: 'product/product-feedback-synthesizer', personaName: '反馈综合师', role: '用户声音' },
    ],
  },

  // ===== 代码开发 =====
  {
    taskType: '网站|网页|前端|落地页',
    label: '网站开发',
    description: '用于「做一个网站」「开发落地页」「改前端页面」这类网站活：前端开发者主导页面实现，后端架构师支撑接口与数据，代码审查员守住合并质量。',
    staffing: [
      { personaId: 'frontend/engineering-frontend-developer', personaName: '前端开发者', role: '页面实现' },
      { personaId: 'engineering/engineering-backend-architect', personaName: '后端架构师', role: '接口与数据' },
      { personaId: 'engineering/engineering-code-reviewer', personaName: '代码审查员', role: '质量把关' },
    ],
  },
  {
    taskType: 'Agent|智能体|MCP|提示词',
    label: 'Agent 应用',
    description: '用于「做一个 Agent」「接入 MCP」「写智能体应用」这类 AI 活：AI 工程师主导架构与编排，MCP 构建师管工具接入，提示词工程师打磨系统指令。',
    staffing: [
      { personaId: 'engineering/engineering-ai-engineer', personaName: 'AI 工程师', role: '架构编排' },
      { personaId: 'specialized/specialized-mcp-builder', personaName: 'MCP 构建师', role: '工具接入' },
      { personaId: 'specialized/prompt-engineer', personaName: '提示词工程师', role: '指令打磨' },
    ],
  },
  {
    taskType: 'skill|技能包|插件',
    label: 'Skill 开发',
    description: '用于「写一个 skill」「做技能包」「封装插件」这类能力封装活：提示词工程师主导 SKILL 设计，AI 工程师管代码与调试，开发者布道师把关文档与示例。',
    staffing: [
      { personaId: 'specialized/prompt-engineer', personaName: '提示词工程师', role: 'SKILL 设计' },
      { personaId: 'engineering/engineering-ai-engineer', personaName: 'AI 工程师', role: '代码调试' },
      { personaId: 'specialized/specialized-developer-advocate', personaName: '开发者布道师', role: '文档示例' },
    ],
  },
  {
    taskType: 'CI|CD|流水线|部署',
    label: 'CI/CD 流水线',
    description: '用于「搭流水线」「配自动部署」「修 CI 报错」这类工程效能活：DevOps 自动化师主导流水线搭建，SRE 管稳定性与告警，代码审查员守住变更质量。',
    staffing: [
      { personaId: 'devops/engineering-devops-automator', personaName: 'DevOps 自动化师', role: '流水线搭建' },
      { personaId: 'engineering/engineering-sre', personaName: 'SRE', role: '稳定性告警' },
      { personaId: 'engineering/engineering-code-reviewer', personaName: '代码审查员', role: '变更把关' },
    ],
  },
  {
    taskType: '技术文档|README|注释',
    label: '开发文档',
    description: '用于「补接口文档」「写 README」「整理技术方案」这类文档活：技术作家主导成文，文字编辑优化结构与表达。',
    staffing: [
      { personaId: 'engineering/engineering-technical-writer', personaName: '技术作家', role: '成文' },
      { personaId: 'publishing/publishing-copy-editor', personaName: '文字编辑', role: '结构润色' },
    ],
  },

  // ===== 设计创意 =====
  {
    taskType: '网页设计|UI|交互',
    label: '网站设计',
    description: '用于「设计网站界面」「出首页视觉稿」这类网页设计活：UI 设计师主导界面方案，UX 架构师定信息架构与动线，创意总监把控整体调性。',
    staffing: [
      { personaId: 'design/design-ui-designer', personaName: 'UI 设计师', role: '界面方案' },
      { personaId: 'design/design-ux-architect', personaName: 'UX 架构师', role: '信息架构' },
      { personaId: 'visual/visual-creative-director', personaName: '创意总监', role: '调性把控' },
    ],
  },
  {
    taskType: 'PPT|美化|版式',
    label: 'PPT 设计',
    description: '用于「美化这份 PPT」「出模板」「重排版式」这类设计向幻灯片活：创意总监定视觉基调，排版设计师精修版式，平面设计师补视觉元素。',
    staffing: [
      { personaId: 'visual/visual-creative-director', personaName: '创意总监', role: '视觉基调' },
      { personaId: 'visual/visual-typography-designer', personaName: '排版设计师', role: '版式精修' },
      { personaId: 'visual/visual-graphic-designer', personaName: '平面设计师', role: '视觉元素' },
    ],
  },
  {
    taskType: 'APP|移动端|小程序',
    label: '移动端应用',
    description: '用于「做一个 APP」「开发小程序」「改移动端页面」这类移动活：移动应用构建师主导开发，小程序开发者管微信生态，UI 设计师保障界面体验。',
    staffing: [
      { personaId: 'frontend/engineering-mobile-app-builder', personaName: '移动应用构建师', role: '应用开发' },
      { personaId: 'engineering/engineering-wechat-mini-program-developer', personaName: '小程序开发者', role: '微信生态' },
      { personaId: 'design/design-ui-designer', personaName: 'UI 设计师', role: '界面体验' },
    ],
  },
  {
    taskType: '设计系统|组件库|规范',
    label: '设计系统',
    description: '用于「建设计系统」「整理组件库」「定设计规范」这类体系化设计活：UI 设计师主导令牌与组件，品牌守护官守一致性，前端开发者保证落地还原。',
    staffing: [
      { personaId: 'design/design-ui-designer', personaName: 'UI 设计师', role: '令牌与组件' },
      { personaId: 'design/design-brand-guardian', personaName: '品牌守护官', role: '一致性' },
      { personaId: 'frontend/engineering-frontend-developer', personaName: '前端开发者', role: '落地还原' },
    ],
  },
  {
    taskType: 'Web应用|全栈|单页',
    label: 'Web 应用',
    description: '用于「做一个 Web 应用」「开发管理后台」「写全栈功能」这类应用活：资深开发者主导端到端实现，前端开发者精修界面，代码审查员守住质量。',
    staffing: [
      { personaId: 'engineering/engineering-senior-developer', personaName: '资深开发者', role: '端到端实现' },
      { personaId: 'frontend/engineering-frontend-developer', personaName: '前端开发者', role: '界面精修' },
      { personaId: 'engineering/engineering-code-reviewer', personaName: '代码审查员', role: '质量把关' },
    ],
  },
  {
    taskType: '品牌|VI|Logo',
    label: '品牌设计',
    description: '用于「设计 Logo」「出 VI 规范」「定品牌视觉」这类品牌活：品牌视觉设计师主导标识与体系，品牌守护官管规范一致性，创意总监定调。',
    staffing: [
      { personaId: 'visual/visual-brand-visual-designer', personaName: '品牌视觉设计师', role: '标识与体系' },
      { personaId: 'design/design-brand-guardian', personaName: '品牌守护官', role: '规范一致性' },
      { personaId: 'visual/visual-creative-director', personaName: '创意总监', role: '调性定调' },
    ],
  },
  {
    taskType: '插画|图标|IP形象',
    label: '图标与插画',
    description: '用于「画一组图标」「出插画」「设计 IP 形象」这类绘制活：插画师主导绘制，平面设计师管风格统一，质量评审员把关交付标准。',
    staffing: [
      { personaId: 'visual/visual-illustrator', personaName: '插画师', role: '绘制' },
      { personaId: 'visual/visual-graphic-designer', personaName: '平面设计师', role: '风格统一' },
      { personaId: 'visual/visual-quality-reviewer', personaName: '质量评审员', role: '交付把关' },
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
