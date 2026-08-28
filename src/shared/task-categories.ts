/**
 * 新建任务三分类（2026-08-28 用户定案）：中栏创建卡的分类 → 子类型两级选择。
 *
 * - 仅 UI 消费（client 创建卡 + hero 快捷入口）；server 侧只透传子类型对应的 blueprintId。
 * - 每个子类型直接绑定一套预制蓝图（blueprintTaskType = blueprint-presets.ts 的 task_type 精确值），
 *   点选 = 显式指定蓝图穿戴，不走标题词元猜测（语义分配是能力管理员的既有链路，用户点选优先级更高）。
 * - 子类型共 22 项：4 项复用既有蓝图（深度研究→调研咨询 / 视频生成→视频制作 /
 *   日常开发→软件交付 / 视觉海报→视觉设计），其余 18 项一一对应新增预制蓝图。
 */

export interface TaskSubtype {
  key: string;
  label: string;
  /** 对应预制蓝图的 task_type（blueprint-presets.ts 精确值）。 */
  blueprintTaskType: string;
}

export interface TaskCategory {
  key: string;
  label: string;
  /** 单字缩写（分类徽标用）。 */
  badge: string;
  subtypes: TaskSubtype[];
}

export const TASK_CATEGORIES: TaskCategory[] = [
  {
    key: 'office',
    label: '日常办公',
    badge: '办',
    subtypes: [
      { key: 'document', label: '文档处理', blueprintTaskType: '文档|合同|排版' },
      { key: 'finance', label: '金融服务', blueprintTaskType: '财务|记账|发票|报销' },
      { key: 'data-viz', label: '数据分析及可视化', blueprintTaskType: '数据|图表|可视化' },
      { key: 'personal-workbench', label: '个人工作台', blueprintTaskType: '个人|工作台|日程|待办' },
      { key: 'slides', label: '幻灯片', blueprintTaskType: '幻灯片|演示文稿|汇报' },
      { key: 'deep-research', label: '深度研究', blueprintTaskType: '调研|行业|分析报告' },
      { key: 'video-gen', label: '视频生成', blueprintTaskType: '视频|剪辑|短片' },
      { key: 'product-mgmt', label: '产品管理', blueprintTaskType: '产品|需求|PRD' },
    ],
  },
  {
    key: 'dev',
    label: '代码开发',
    badge: '码',
    subtypes: [
      { key: 'daily-dev', label: '日常开发', blueprintTaskType: '软件|开发|代码|修复' },
      { key: 'website-dev', label: '网站开发', blueprintTaskType: '网站|网页|前端|落地页' },
      { key: 'agent-app', label: 'Agent 应用', blueprintTaskType: 'Agent|智能体|MCP|提示词' },
      { key: 'skill-dev', label: 'skill 开发', blueprintTaskType: 'skill|技能包|插件' },
      { key: 'ci-cd', label: 'CI/CD', blueprintTaskType: 'CI|CD|流水线|部署' },
      { key: 'dev-docs', label: '文档', blueprintTaskType: '技术文档|README|注释' },
    ],
  },
  {
    key: 'design',
    label: '设计创意',
    badge: '设',
    subtypes: [
      { key: 'web-design', label: '网站设计', blueprintTaskType: '网页设计|UI|交互' },
      { key: 'ppt-design', label: 'PPT 设计', blueprintTaskType: 'PPT|美化|版式' },
      { key: 'poster', label: '视觉海报', blueprintTaskType: '设计|海报|视觉' },
      { key: 'mobile-app', label: '移动端 APP', blueprintTaskType: 'APP|移动端|小程序' },
      { key: 'design-system', label: '设计系统', blueprintTaskType: '设计系统|组件库|规范' },
      { key: 'webapp', label: 'WebAPP', blueprintTaskType: 'Web应用|全栈|单页' },
      { key: 'brand', label: '品牌设计', blueprintTaskType: '品牌|VI|Logo' },
      { key: 'icon-illustration', label: '图标&插画', blueprintTaskType: '插画|图标|IP形象' },
    ],
  },
];

/** 按 key 找子类型（跨分类，找不到返回 null）。 */
export function findTaskSubtype(subtypeKey: string): { category: TaskCategory; subtype: TaskSubtype } | null {
  for (const category of TASK_CATEGORIES) {
    const subtype = category.subtypes.find((s) => s.key === subtypeKey);
    if (subtype) return { category, subtype };
  }
  return null;
}
