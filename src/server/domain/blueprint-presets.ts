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
 *
 * 2026-08-29 批次①：每套带默认阶段工作流（stages，连线画布开箱不空）+ 描述精简；
 * 已播种的存量行走 ensureBackfill 增量补齐——只刷新「用户未改动过」的字段（stages 为空才补、
 * 描述仍等于旧快照才换），快照同步升级保证「重置为原版」能拿到带 stages 的原版。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { commitBlueprintVersion, type BlueprintPresetSnapshot, type BlueprintStaffingSlot } from './blueprint';
import { type BlueprintStage } from '../../shared/blueprint-stages';
import { getSetting, setSetting } from './setting';

/**
 * 预制定义版本标记：本套定义（含默认 stages+精简描述）完成播种/回填后写入 settings，
 * 之后 ensure 走稳态快路（存在性查重一次全表 task_type 扫描，不再逐行拉快照 JSON 做回填比对）——
 * ensureBlueprintPresets 挂在 /api/agents 等高频端点上，稳态必须 O( defs ) 而非 O( defs × snapshot )。
 * 升级定义时 bump 此版本号即可重新触发一次全量回填。
 */
const PRESET_DEF_VERSION = '2026-08-29.1';
const PRESET_DEF_VERSION_KEY = 'blueprint_preset_def_version';

export interface BlueprintPresetDef {
  /** 任务类型词元（| 拼接），高信号词 2-4 个。 */
  taskType: string;
  label: string;
  description: string;
  /** 班底：主槽在前（任务穿戴主专家），协作槽随后（注入协作提示）。 */
  staffing: BlueprintStaffingSlot[];
  /** 默认阶段工作流（线性 1..n；画布可再改依赖关系，写回走 updateBlueprintStages）。 */
  stages: BlueprintStage[];
}

/** 线性阶段流水线速记：labels 顺序即 step 顺序。 */
function flow(labels: Array<[label: string, description: string]>): BlueprintStage[] {
  return labels.map(([label, description], i) => ({ id: `stage_${i + 1}`, step: i + 1, label, description }));
}

export const BLUEPRINT_PRESETS: BlueprintPresetDef[] = [
  {
    taskType: '小说|正文|章节',
    label: '长篇小说创作',
    description: '用于「写一章小说」「修订正文」这类创作活：主笔执笔，主编把方向与节奏，连续性审校盯设定与前后文冲突。',
    staffing: [
      { personaId: 'novel/novel-writer', personaName: '小说主笔', role: '执笔' },
      { personaId: 'novel/novel-chief-editor', personaName: '小说主编', role: '方向与节奏' },
      { personaId: 'novel/novel-plot-architect', personaName: '情节架构师', role: '主线与伏笔' },
      { personaId: 'novel/novel-continuity-reviewer', personaName: '连续性审校', role: '一致性检查' },
    ],
    stages: flow([
      ['大纲与设定梳理', '对齐本章目标、人物状态与伏笔清单'],
      ['章节正文写作', '主笔按大纲成稿，节奏与文风保持一致'],
      ['连续性审校', '核对设定、时间线与前后文冲突'],
      ['交付归档', '定稿入项目，更新设定簿'],
    ]),
  },
  {
    taskType: '软件|开发|代码|修复',
    label: '软件交付',
    description: '用于「开发一个功能」「修复 bug」这类工程活：架构师主导设计与实现，前端跟进界面，审查员守住合并质量。',
    staffing: [
      { personaId: 'engineering/engineering-software-architect', personaName: '软件架构师', role: '设计与实现' },
      { personaId: 'frontend/engineering-frontend-developer', personaName: '前端开发者', role: '界面实现' },
      { personaId: 'engineering/engineering-code-reviewer', personaName: '代码审查员', role: '质量把关' },
    ],
    stages: flow([
      ['需求分析与方案设计', '解析目标、确定边界与技术路径'],
      ['编码实现', '编写代码与功能执行'],
      ['代码审查', '按规范审查变更，守住合并质量'],
      ['验收与归档', '对照验收标准自评并归档'],
    ]),
  },
  {
    taskType: '文章|写作|公众号',
    label: '内容写作',
    description: '用于「写一篇文章」「公众号推文」这类内容活：创作者主笔成稿，文字编辑优化结构与语言，主编把关选题与质量。',
    staffing: [
      { personaId: 'marketing/marketing-content-creator', personaName: '内容创作者', role: '主笔' },
      { personaId: 'publishing/publishing-copy-editor', personaName: '文字编辑', role: '结构润色' },
      { personaId: 'publishing/publishing-editor-in-chief', personaName: '主编', role: '质量把关' },
    ],
    stages: flow([
      ['选题与结构规划', '明确读者、角度与文章骨架'],
      ['初稿撰写', '创作者按结构成稿'],
      ['编辑润色', '优化结构、语言与事实核对'],
      ['终审定稿', '主编把关后交付发布'],
    ]),
  },
  {
    taskType: '营销|推广|宣传',
    label: '营销推广',
    description: '用于「营销方案」「推广活动」这类增长活：增长黑客主导策略与实验，SEO 管搜索流量，社媒策略师管渠道内容。',
    staffing: [
      { personaId: 'marketing/marketing-growth-hacker', personaName: '增长黑客', role: '策略与实验' },
      { personaId: 'marketing/marketing-seo-specialist', personaName: 'SEO专家', role: '搜索流量' },
      { personaId: 'marketing/marketing-social-media-strategist', personaName: '社交媒体策略师', role: '渠道运营' },
    ],
    stages: flow([
      ['策略与目标拆解', '定目标人群、指标与打法'],
      ['方案与创意产出', '产出活动方案与素材创意'],
      ['渠道执行', '各渠道投放与内容落地'],
      ['效果复盘', '回收数据，沉淀下一步打法'],
    ]),
  },
  {
    taskType: '调研|行业|分析报告',
    label: '调研咨询',
    description: '用于「行业调研」「竞品分析」「分析报告」这类研究活：研究员定框架，投资研究员深拆，高管摘要师把结论压成一页。',
    staffing: [
      { personaId: 'product/product-trend-researcher', personaName: '趋势研究员', role: '课题与框架' },
      { personaId: 'data/finance-investment-researcher', personaName: '投资研究员', role: '深度分析' },
      { personaId: 'specialized/support-executive-summary-generator', personaName: '高管摘要师', role: '结论提炼' },
    ],
    stages: flow([
      ['课题与框架设计', '明确研究问题与信息框架'],
      ['资料采集与分析', '收集信源并交叉验证'],
      ['报告撰写', '结构化成文，图表辅助论证'],
      ['结论提炼与交付', '压成一页可决策的摘要'],
    ]),
  },
  {
    taskType: '视频|剪辑|短片',
    label: '视频制作',
    description: '用于「拍一条视频」「剪辑短片」这类创作活：导演统筹叙事与分镜，编剧出脚本，剪辑师成片。',
    staffing: [
      { personaId: 'video/video-director', personaName: '导演', role: '叙事统筹' },
      { personaId: 'video/video-screenwriter', personaName: '编剧', role: '脚本撰写' },
      { personaId: 'video/video-editor', personaName: '剪辑师', role: '成片剪辑' },
    ],
    stages: flow([
      ['创意与脚本', '定叙事目标，编剧出脚本'],
      ['分镜规划', '导演拆分镜与素材清单'],
      ['剪辑成片', '剪辑师粗剪到精修'],
      ['审片与交付', '对照目标审片后交付'],
    ]),
  },
  {
    taskType: '设计|海报|视觉',
    label: '视觉设计',
    description: '用于「设计一张海报」「品牌视觉」这类设计活：创意总监定调性与方案，平面设计师落地执行。',
    staffing: [
      { personaId: 'visual/visual-creative-director', personaName: '创意总监', role: '创意定调' },
      { personaId: 'visual/visual-graphic-designer', personaName: '平面设计师', role: '落地执行' },
    ],
    stages: flow([
      ['创意定调', '明确用途、受众与视觉方向'],
      ['方案设计', '产出主视觉方案'],
      ['精修与适配', '多尺寸适配与细节精修'],
      ['交付归档', '源文件与导出件归档'],
    ]),
  },
  {
    taskType: '出版|书稿|选题',
    label: '出版策划',
    description: '用于「出版策划」「书稿整理」这类出版活：主编统筹选题与质量，策划编辑定内容规划，校对员兜底文字差错。',
    staffing: [
      { personaId: 'publishing/publishing-editor-in-chief', personaName: '主编', role: '统筹把关' },
      { personaId: 'publishing/publishing-content-planner', personaName: '策划编辑', role: '内容规划' },
      { personaId: 'publishing/publishing-proofreader', personaName: '校对员', role: '文字校对' },
    ],
    stages: flow([
      ['选题论证', '评估选题价值与读者定位'],
      ['内容规划', '定章节结构与写作计划'],
      ['书稿整理', '组稿、统稿与体例统一'],
      ['校对定稿', '三轮校对后定稿交付'],
    ]),
  },
  // ── 以下 18 套（2026-08-28）：新建任务三分类（日常办公/代码开发/设计创意）子类型专属蓝图。
  // 创建卡点选子类型 = 直接绑定（blueprintId 直通），词元仅作自由标题的兜底匹配。

  // ===== 日常办公 =====
  {
    taskType: '文档|合同|排版',
    label: '文档处理',
    description: '用于「整理一份文档」「起草合同」「排版输出」这类文档活：文档工程师生成与格式化，文字编辑润色，校对员兜底。',
    staffing: [
      { personaId: 'specialized/specialized-document-generator', personaName: '文档工程师', role: '生成与格式化' },
      { personaId: 'publishing/publishing-copy-editor', personaName: '文字编辑', role: '结构润色' },
      { personaId: 'publishing/publishing-proofreader', personaName: '校对员', role: '文字校对' },
    ],
    stages: flow([
      ['需求与素材整理', '明确文档用途，收齐素材'],
      ['文档起草', '按体例生成初稿'],
      ['排版输出', '格式化与版式处理'],
      ['校对交付', '校对差错后交付'],
    ]),
  },
  {
    taskType: '财务|记账|发票|报销',
    label: '金融服务',
    description: '用于「记账」「整理发票」「财务报表」「税务筹划」这类财务活：记账员管凭证，分析师出报表，税务师管合规。',
    staffing: [
      { personaId: 'data/finance-bookkeeper-controller', personaName: '财务记账员', role: '账目与凭证' },
      { personaId: 'data/finance-financial-analyst', personaName: '财务分析师', role: '报表与解读' },
      { personaId: 'data/finance-tax-strategist', personaName: '税务策略师', role: '合规与优化' },
    ],
    stages: flow([
      ['凭证与数据收集', '收齐票据、流水与凭据'],
      ['记账与核对', '入账并逐笔核对'],
      ['报表与分析', '出报表并解读异常'],
      ['归档备查', '凭证归档，留痕备查'],
    ]),
  },
  {
    taskType: '数据|图表|可视化',
    label: '数据分析及可视化',
    description: '用于「分析这份数据」「做可视化看板」这类数据活：数据工程师清洗加工，分析报告师出结论，设计师呈现到位。',
    staffing: [
      { personaId: 'backend/engineering-data-engineer', personaName: '数据工程师', role: '清洗与加工' },
      { personaId: 'specialized/support-analytics-reporter', personaName: '分析报告师', role: '结论提炼' },
      { personaId: 'visual/visual-graphic-designer', personaName: '平面设计师', role: '图表呈现' },
    ],
    stages: flow([
      ['数据清洗与加工', '核对口径，清洗加工成可用数据'],
      ['分析与结论', '跑数并提炼结论'],
      ['可视化呈现', '图表/看板设计与制作'],
      ['交付', '连同口径说明一并交付'],
    ]),
  },
  {
    taskType: '个人|工作台|日程|待办',
    label: '个人工作台',
    description: '用于「安排我的一天」「整理待办」这类个人效率活：幕僚长排优先级，会议助理管日程纪要，项目管家盯跟进。',
    staffing: [
      { personaId: 'specialized/specialized-chief-of-staff', personaName: '幕僚长', role: '统筹优先级' },
      { personaId: 'specialized/specialized-meeting-assistant', personaName: '会议助理', role: '日程与纪要' },
      { personaId: 'product/project-management-project-shepherd', personaName: '项目管家', role: '跟进不漏项' },
    ],
    stages: flow([
      ['事项收集与优先级', '汇集来源，排出轻重缓急'],
      ['日程编排', '落到时间块与提醒'],
      ['执行跟进', '推进中盯节点不漏项'],
      ['每日复盘', '收口未竟事项，滚动到明天'],
    ]),
  },
  {
    taskType: '幻灯片|演示文稿|汇报',
    label: '幻灯片演示',
    description: '用于「做一份汇报幻灯片」这类汇报活：视觉叙事师搭故事线，排版设计师定版式，平面设计师补配图图示。',
    staffing: [
      { personaId: 'design/design-visual-storyteller', personaName: '视觉叙事师', role: '叙事结构' },
      { personaId: 'visual/visual-typography-designer', personaName: '排版设计师', role: '版式节奏' },
      { personaId: 'visual/visual-graphic-designer', personaName: '平面设计师', role: '配图图示' },
    ],
    stages: flow([
      ['叙事结构设计', '定汇报目标与故事线'],
      ['内容与版式制作', '逐页成稿，版式统一'],
      ['排练与打磨', '试讲校时，删冗余页'],
      ['交付', '终稿交付并留档'],
    ]),
  },
  {
    taskType: '产品|需求|PRD',
    label: '产品管理',
    description: '用于「写一份 PRD」「梳理需求」这类产品活：产品经理定需求方案，排序师管优先级，反馈综合师汇用户声音。',
    staffing: [
      { personaId: 'product/product-manager', personaName: '产品经理', role: '需求定义' },
      { personaId: 'product/product-sprint-prioritizer', personaName: '冲刺排序师', role: '优先级' },
      { personaId: 'product/product-feedback-synthesizer', personaName: '反馈综合师', role: '用户声音' },
    ],
    stages: flow([
      ['需求收集与澄清', '汇集来源并澄清边界'],
      ['PRD 撰写', '结构化成文含验收标准'],
      ['优先级排序', '按价值/成本排期'],
      ['评审定稿', '过评审后定稿归档'],
    ]),
  },

  // ===== 代码开发 =====
  {
    taskType: '网站|网页|前端|落地页',
    label: '网站开发',
    description: '用于「做一个网站」「开发落地页」这类网站活：前端主导页面实现，后端撑接口与数据，审查员守住质量。',
    staffing: [
      { personaId: 'frontend/engineering-frontend-developer', personaName: '前端开发者', role: '页面实现' },
      { personaId: 'backend/engineering-backend-architect', personaName: '后端架构师', role: '接口与数据' },
      { personaId: 'engineering/engineering-code-reviewer', personaName: '代码审查员', role: '质量把关' },
    ],
    stages: flow([
      ['页面与接口设计', '定页面结构、交互与接口契约'],
      ['前端实现', '页面与组件开发'],
      ['联调与测试', '接口联调，走查边界情况'],
      ['上线交付', '部署验证后交付'],
    ]),
  },
  {
    taskType: 'Agent|智能体|MCP|提示词',
    label: 'Agent 应用',
    description: '用于「做一个 Agent」「接入 MCP」这类 AI 活：AI 工程师管架构编排，MCP 构建师接工具，提示词工程师磨指令。',
    staffing: [
      { personaId: 'engineering/engineering-ai-engineer', personaName: 'AI 工程师', role: '架构编排' },
      { personaId: 'specialized/specialized-mcp-builder', personaName: 'MCP 构建师', role: '工具接入' },
      { personaId: 'specialized/prompt-engineer', personaName: '提示词工程师', role: '指令打磨' },
    ],
    stages: flow([
      ['架构与编排设计', '定 Agent 角色、工具与数据流'],
      ['提示词与工具接入', '打磨系统指令，接好工具'],
      ['调试验证', '端到端跑通，修坏例'],
      ['部署交付', '上线并留使用说明'],
    ]),
  },
  {
    taskType: 'skill|技能包|插件',
    label: 'Skill 开发',
    description: '用于「写一个 skill」「做技能包插件」这类能力封装活：提示词工程师主导设计，AI 工程师调试，布道师管文档示例。',
    staffing: [
      { personaId: 'specialized/prompt-engineer', personaName: '提示词工程师', role: 'SKILL 设计' },
      { personaId: 'engineering/engineering-ai-engineer', personaName: 'AI 工程师', role: '代码调试' },
      { personaId: 'specialized/specialized-developer-advocate', personaName: '开发者布道师', role: '文档示例' },
    ],
    stages: flow([
      ['SKILL 设计', '定触发场景、流程与产出物'],
      ['实现与调试', '写实现并跑通典型用例'],
      ['文档与示例', '补 README 与示例'],
      ['发布', '登记入库并发布'],
    ]),
  },
  {
    taskType: 'CI|CD|流水线|部署',
    label: 'CI/CD 流水线',
    description: '用于「搭流水线」「配自动部署」这类工程效能活：DevOps 自动化师搭建，SRE 管稳定性告警，审查员守变更。',
    staffing: [
      { personaId: 'devops/engineering-devops-automator', personaName: 'DevOps 自动化师', role: '流水线搭建' },
      { personaId: 'devops/engineering-sre', personaName: 'SRE', role: '稳定性告警' },
      { personaId: 'engineering/engineering-code-reviewer', personaName: '代码审查员', role: '变更把关' },
    ],
    stages: flow([
      ['流水线方案设计', '定阶段、触发与准入标准'],
      ['搭建与配置', '落流水线与部署配置'],
      ['验证与灰度', '全链路验证，灰度放量'],
      ['交付与监控', '配好告警后交付'],
    ]),
  },
  {
    taskType: '技术文档|README|注释',
    label: '开发文档',
    description: '用于「补接口文档」「写 README」这类文档活：技术作家主导成文，文字编辑优化结构与表达。',
    staffing: [
      { personaId: 'engineering/engineering-technical-writer', personaName: '技术作家', role: '成文' },
      { personaId: 'publishing/publishing-copy-editor', personaName: '文字编辑', role: '结构润色' },
    ],
    stages: flow([
      ['资料与代码梳理', '读代码与既有资料，定文档范围'],
      ['成文撰写', '按读者层次结构化成文'],
      ['结构润色', '统一术语与行文'],
      ['校对发布', '技术校对后随库发布'],
    ]),
  },

  // ===== 设计创意 =====
  {
    taskType: '网页设计|UI|交互',
    label: '网站设计',
    description: '用于「设计网站界面」「出首页视觉稿」这类活：UI 设计师出界面方案，UX 架构师定信息架构与动线，创意总监把控调性。',
    staffing: [
      { personaId: 'design/design-ui-designer', personaName: 'UI 设计师', role: '界面方案' },
      { personaId: 'design/design-ux-architect', personaName: 'UX 架构师', role: '信息架构' },
      { personaId: 'visual/visual-creative-director', personaName: '创意总监', role: '调性把控' },
    ],
    stages: flow([
      ['信息架构与动线', '定页面层级与用户路径'],
      ['界面方案设计', '关键页面出高保真方案'],
      ['视觉与交互细化', '组件、状态与响应式细化'],
      ['交付还原', '标注切图，配合前端还原'],
    ]),
  },
  {
    taskType: 'PPT|美化|版式',
    label: 'PPT 设计',
    description: '用于「美化这份 PPT」「出模板」「重排版式」这类设计向幻灯片活：创意总监定基调，排版师精修版式，平面补视觉元素。',
    staffing: [
      { personaId: 'visual/visual-creative-director', personaName: '创意总监', role: '视觉基调' },
      { personaId: 'visual/visual-typography-designer', personaName: '排版设计师', role: '版式精修' },
      { personaId: 'visual/visual-graphic-designer', personaName: '平面设计师', role: '视觉元素' },
    ],
    stages: flow([
      ['视觉基调确定', '定风格、配色与字体系统'],
      ['版式精修', '逐页重排，统一节奏'],
      ['视觉元素补充', '配图、图标与图示补齐'],
      ['交付', '终稿与源文件交付'],
    ]),
  },
  {
    taskType: 'APP|移动端|小程序',
    label: '移动端应用',
    description: '用于「做一个 APP」「开发小程序」这类移动活：移动构建师主导开发，小程序开发者管生态，UI 设计师保障体验。',
    staffing: [
      { personaId: 'frontend/engineering-mobile-app-builder', personaName: '移动应用构建师', role: '应用开发' },
      { personaId: 'engineering/engineering-wechat-mini-program-developer', personaName: '小程序开发者', role: '微信生态' },
      { personaId: 'design/design-ui-designer', personaName: 'UI 设计师', role: '界面体验' },
    ],
    stages: flow([
      ['应用方案设计', '定功能范围、页面流与技术栈'],
      ['开发实现', '核心功能编码实现'],
      ['适配与测试', '多机型适配与真机测试'],
      ['发布', '提审发布与版本管理'],
    ]),
  },
  {
    taskType: '设计系统|组件库|规范',
    label: '设计系统',
    description: '用于「建设计系统」「整理组件库」「定规范」这类体系化设计活：UI 设计师主导令牌与组件，守护官守一致性，前端保还原。',
    staffing: [
      { personaId: 'design/design-ui-designer', personaName: 'UI 设计师', role: '令牌与组件' },
      { personaId: 'design/design-brand-guardian', personaName: '品牌守护官', role: '一致性' },
      { personaId: 'frontend/engineering-frontend-developer', personaName: '前端开发者', role: '落地还原' },
    ],
    stages: flow([
      ['令牌与规范定义', '定色彩/字体/间距令牌'],
      ['组件设计', '组件族设计与状态覆盖'],
      ['一致性审查', '守护官按规范审查存量'],
      ['落地对接', '前端组件化并文档化'],
    ]),
  },
  {
    taskType: 'Web应用|全栈|单页',
    label: 'Web 应用',
    description: '用于「做一个 Web 应用」「写全栈功能」这类应用活：资深开发者端到端实现，前端精修界面，审查员守住质量。',
    staffing: [
      { personaId: 'engineering/engineering-senior-developer', personaName: '资深开发者', role: '端到端实现' },
      { personaId: 'frontend/engineering-frontend-developer', personaName: '前端开发者', role: '界面精修' },
      { personaId: 'engineering/engineering-code-reviewer', personaName: '代码审查员', role: '质量把关' },
    ],
    stages: flow([
      ['端到端方案设计', '定数据模型、接口与页面结构'],
      ['全栈实现', '前后端功能实现'],
      ['界面精修与审查', '交互打磨并过代码审查'],
      ['交付', '部署验证后交付'],
    ]),
  },
  {
    taskType: '品牌|VI|Logo',
    label: '品牌设计',
    description: '用于「设计 Logo」「出 VI 规范」这类品牌活：品牌视觉设计师主导标识与体系，守护官管规范一致性，创意总监定调。',
    staffing: [
      { personaId: 'visual/visual-brand-visual-designer', personaName: '品牌视觉设计师', role: '标识与体系' },
      { personaId: 'design/design-brand-guardian', personaName: '品牌守护官', role: '规范一致性' },
      { personaId: 'visual/visual-creative-director', personaName: '创意总监', role: '调性定调' },
    ],
    stages: flow([
      ['品牌调研与定调', '理解业务与受众，定品牌方向'],
      ['标识与体系设计', 'Logo 方案与视觉体系'],
      ['规范整理', 'VI 应用规范成册'],
      ['交付', '源文件与规范包交付'],
    ]),
  },
  {
    taskType: '插画|图标|IP形象',
    label: '图标与插画',
    description: '用于「画一组图标」「出插画」「设计 IP 形象」这类绘制活：插画师主导绘制，平面管风格统一，评审员把交付关。',
    staffing: [
      { personaId: 'visual/visual-illustrator', personaName: '插画师', role: '绘制' },
      { personaId: 'visual/visual-graphic-designer', personaName: '平面设计师', role: '风格统一' },
      { personaId: 'visual/visual-quality-reviewer', personaName: '质量评审员', role: '交付把关' },
    ],
    stages: flow([
      ['风格定调', '定风格样本与规格'],
      ['绘制执行', '按清单逐项绘制'],
      ['风格统一检查', '整套一致性核对'],
      ['交付', '多格式导出归档'],
    ]),
  },
];

interface PresetRow {
  id: string;
  source?: string | null;
  description: string;
  stages_json: string | null;
  preset_snapshot_json: string | null;
}

/**
 * 幂等播种预制蓝图：按 taskType 精确查重（含全部状态——用户 retire 后重启不复活），
 * 不存在才插入（source='preset' + 原版快照），并留版本记录。
 * 已存在的预制行走增量回填（2026-08-29 批次①）：补空 stages、刷新未改动过的描述——
 * 用户改过的字段（描述≠旧快照、stages 非空）一律不碰，快照同步升级保证重置语义。
 * 回填只在定义版本标记缺失/过期时执行一次（高频端点稳态快路，见 PRESET_DEF_VERSION）。
 */
export function ensureBlueprintPresets(db: DB): void {
  const now = nowIso();
  const steady = getSetting(db, PRESET_DEF_VERSION_KEY, '') === PRESET_DEF_VERSION;
  const existing = new Set(
    (db.prepare('SELECT task_type FROM blueprint').all() as Array<{ task_type: string }>).map((r) => r.task_type),
  );

  for (const preset of BLUEPRINT_PRESETS) {
    if (!existing.has(preset.taskType)) {
      const id = shortId('bp_');
      const snapshot: BlueprintPresetSnapshot = {
        taskType: preset.taskType,
        label: preset.label,
        description: preset.description,
        staffing: preset.staffing,
        stages: preset.stages,
      };
      db.transaction(() => {
        db.prepare(
          `INSERT INTO blueprint (id, task_type, label, description, staffing_json, tools_json,
             source_project_ids_json, wins, losses, rework_total, correction_total, status,
             created_at, updated_at, source, preset_snapshot_json, stages_json)
           VALUES (?, ?, ?, ?, ?, '[]', '[]', 0, 0, 0, 0, 'active', ?, ?, 'preset', ?, ?)`,
        ).run(
          id, preset.taskType, preset.label, preset.description,
          JSON.stringify(preset.staffing),
          now, now,
          JSON.stringify(snapshot),
          JSON.stringify(preset.stages),
        );
        commitBlueprintVersion(db, id, '预制蓝图就位：开箱即用的官方打法，随真实战绩持续进化（原版存快照，可随时重置）', ['preset']);
      })();
      continue;
    }
    if (steady) continue; // 稳态快路：定义已就位，跳过回填比对

    const row = db.prepare(
      'SELECT id, source, description, stages_json, preset_snapshot_json FROM blueprint WHERE task_type=?',
    ).get(preset.taskType) as PresetRow | undefined;
    if (!row || (row.source ?? 'evolved') !== 'preset') continue;
    const snap = row.preset_snapshot_json
      ? JSON.parse(row.preset_snapshot_json) as BlueprintPresetSnapshot
      : null;
    if (!snap) continue;

    const changed: string[] = [];
    let stagesJson: string | null = row.stages_json;
    const currentStages = row.stages_json ? JSON.parse(row.stages_json) as unknown[] : [];
    if (currentStages.length === 0) {
      stagesJson = JSON.stringify(preset.stages);
      snap.stages = preset.stages;
      changed.push('补默认阶段工作流');
    }
    let description = row.description;
    if (row.description === snap.description && snap.description !== preset.description) {
      description = preset.description;
      snap.description = preset.description;
      changed.push('精简描述');
    }
    if (changed.length === 0) continue;

    db.transaction(() => {
      db.prepare(
        'UPDATE blueprint SET stages_json=?, description=?, preset_snapshot_json=?, updated_at=? WHERE id=?',
      ).run(stagesJson, description, JSON.stringify(snap), nowIso(), row.id);
      commitBlueprintVersion(db, row.id, `预制定义升级：${changed.join('、')}（只刷新未被用户改动过的字段）`, ['preset_upgrade']);
    })();
  }

  if (!steady) setSetting(db, PRESET_DEF_VERSION_KEY, PRESET_DEF_VERSION);
}
