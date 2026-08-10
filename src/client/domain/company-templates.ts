import type {
  CompanyTemplateDraft,
  CompanyTemplateId as SharedCompanyTemplateId,
  SetupBindings as SharedSetupBindings,
} from '../../shared/company-template';

export type CompanyTemplateId = SharedCompanyTemplateId;

export interface CompanyTemplateOption {
  id: CompanyTemplateId;
  name: string;
  category: 'engineering' | 'creative' | 'business';
  description: string;
  roles: string[];
  mark: string;
  colorToken: 'blue' | 'orange' | 'green' | 'red' | 'purple' | 'neutral';
  maturity: 'ready' | 'needs_configuration' | 'experimental' | 'blueprint_only';
  recommendedUse: string;
  version: number;
}

export type CompanySetupDraft = CompanyTemplateDraft;
export type SetupBindings = SharedSetupBindings;

export const COMPANY_TEMPLATE_OPTIONS: CompanyTemplateOption[] = [
  { id: 'general', name: '通用项目公司', category: 'engineering', description: '适合研究、运营和跨职能工作', roles: ['lead', 'specialist', 'reviewer'], mark: '通', colorToken: 'blue', maturity: 'ready', recommendedUse: '通用项目', version: 1 },
  { id: 'software', name: '软件研发公司', category: 'engineering', description: '适合产品设计、开发和质量验证', roles: ['lead', 'product', 'engineer', 'reviewer'], mark: '码', colorToken: 'orange', maturity: 'ready', recommendedUse: '软件产品交付', version: 1 },
  { id: 'content', name: '内容创作公司', category: 'creative', description: '适合策划、创作、编辑和发布', roles: ['lead', 'planner', 'creator', 'editor'], mark: '创', colorToken: 'green', maturity: 'ready', recommendedUse: '内容策划与发布', version: 1 },
  { id: 'novel', name: '长篇小说公司', category: 'creative', description: '内置人物、情节和连续性协作流程', roles: ['lead', 'writer', 'character', 'plot', 'inspector'], mark: '文', colorToken: 'red', maturity: 'ready', recommendedUse: '长篇小说创作', version: 1 },
  { id: 'marketing', name: '品牌营销公司', category: 'business', description: '适合市场调研、公关传播与增长推广', roles: ['lead', 'analyst', 'copywriter', 'pr_specialist'], mark: '销', colorToken: 'orange', maturity: 'ready', recommendedUse: '整合营销与品牌传播', version: 1 },
  { id: 'consulting', name: '行业咨询公司', category: 'business', description: '适合行业研报、竞争分析与战略咨询', roles: ['lead', 'expert', 'data_analyst', 'editor'], mark: '询', colorToken: 'purple', maturity: 'ready', recommendedUse: '行业研究与战略建议', version: 1 },
  { id: 'visual', name: '图片制作公司', category: 'creative', description: '适合插画、平面设计与 AI 绘图素材制作', roles: ['lead', 'designer', 'illustrator', 'ai_engineer', 'retoucher', 'reviewer'], mark: '图', colorToken: 'blue', maturity: 'needs_configuration', recommendedUse: '视觉素材制作', version: 1 },
  { id: 'video', name: '影视制作公司', category: 'creative', description: '适合脚本、分镜、剪辑与成片制作', roles: ['lead', 'screenwriter', 'director', 'storyboard', 'editor', 'colorist', 'synthesist'], mark: '影', colorToken: 'red', maturity: 'needs_configuration', recommendedUse: '短视频与成片制作', version: 1 },
  { id: 'publishing', name: '编辑出版公司', category: 'creative', description: '适合选题策划、编辑校对与出版发行', roles: ['lead', 'planner', 'editor', 'fact_checker', 'proofreader', 'layout'], mark: '版', colorToken: 'green', maturity: 'ready', recommendedUse: '内容编辑出版', version: 1 },
  { id: 'social', name: '社媒运营公司', category: 'creative', description: '适合小红书、抖音、B 站等内容发布与账号运营', roles: ['lead', 'planner', 'copywriter', 'cover_designer', 'operator', 'analyst'], mark: '社', colorToken: 'orange', maturity: 'ready', recommendedUse: '社媒内容与账号运营', version: 1 },
];

export function getCompanyTemplate(id: CompanyTemplateId): CompanyTemplateOption {
  const template = COMPANY_TEMPLATE_OPTIONS.find((item) => item.id === id);
  if (!template) throw new Error(`Unknown company template: ${id}`);
  return template;
}

export interface ProjectCreationPreset {
  allowNovelWizard: boolean;
  subtitle: string;
  initialTaskTitle: string;
  namePlaceholder: string;
  descriptionPlaceholder: string;
  preferredAssigneeRoles: string[];
}

const PROJECT_CREATION_PRESETS: Record<'general' | 'software' | 'content' | 'novel' | 'marketing' | 'consulting' | 'visual' | 'video' | 'publishing' | 'social', ProjectCreationPreset> = {
  general: {
    allowNovelWizard: false,
    subtitle: '为通用项目公司创建一个新的交付项目',
    initialTaskTitle: '明确目标并制定执行方案',
    namePlaceholder: '例如：季度运营改进',
    descriptionPlaceholder: '一句话说明项目目标（选填）',
    preferredAssigneeRoles: ['specialist', 'lead'],
  },
  software: {
    allowNovelWizard: false,
    subtitle: '为软件研发公司创建一个新的交付项目',
    initialTaskTitle: '梳理需求并制定实施计划',
    namePlaceholder: '例如：移动端体验升级',
    descriptionPlaceholder: '说明产品目标或交付范围（选填）',
    preferredAssigneeRoles: ['engineer', 'product', 'lead'],
  },
  content: {
    allowNovelWizard: false,
    subtitle: '为内容创作公司创建一个新的内容项目',
    initialTaskTitle: '确定受众、主题与内容计划',
    namePlaceholder: '例如：夏季品牌内容专题',
    descriptionPlaceholder: '说明主题、受众或发布目标（选填）',
    preferredAssigneeRoles: ['planner', 'creator', 'lead'],
  },
  novel: {
    allowNovelWizard: true,
    subtitle: '为长篇小说公司发布一个新的故事创作企划',
    initialTaskTitle: '编写第一章',
    namePlaceholder: '例如：星辰变',
    descriptionPlaceholder: '一句话描述这本小说（选填）',
    preferredAssigneeRoles: ['writer', 'lead'],
  },
  marketing: {
    allowNovelWizard: false,
    subtitle: '为品牌营销公司创建一个新的整合营销项目',
    initialTaskTitle: '分析目标受众与撰写方案',
    namePlaceholder: '例如：夏季新品上市营销',
    descriptionPlaceholder: '说明营销目标与传播渠道（选填）',
    preferredAssigneeRoles: ['analyst', 'copywriter', 'lead'],
  },
  consulting: {
    allowNovelWizard: false,
    subtitle: '为行业咨询公司创建一个新的深度研究项目',
    initialTaskTitle: '确定研究课题与分析框架',
    namePlaceholder: '例如：2026 AI 行业发展白皮书',
    descriptionPlaceholder: '说明课题范围与交付重点（选填）',
    preferredAssigneeRoles: ['expert', 'data_analyst', 'lead'],
  },
  visual: {
    allowNovelWizard: false,
    subtitle: '为图片制作公司创建一个新的视觉项目',
    initialTaskTitle: '明确视觉需求与创意方向',
    namePlaceholder: '例如：品牌主视觉设计',
    descriptionPlaceholder: '说明视觉用途、风格与交付物（选填）',
    preferredAssigneeRoles: ['designer', 'ai_engineer', 'lead'],
  },
  video: {
    allowNovelWizard: false,
    subtitle: '为影视制作公司创建一个新的视频项目',
    initialTaskTitle: '明确视频目标、受众与脚本方向',
    namePlaceholder: '例如：产品宣传短片',
    descriptionPlaceholder: '说明视频用途、时长与风格（选填）',
    preferredAssigneeRoles: ['screenwriter', 'director', 'lead'],
  },
  publishing: {
    allowNovelWizard: false,
    subtitle: '为编辑出版公司创建一个新的出版项目',
    initialTaskTitle: '确定选题方向与内容规划',
    namePlaceholder: '例如：年度行业报告',
    descriptionPlaceholder: '说明选题、受众与出版目标（选填）',
    preferredAssigneeRoles: ['planner', 'editor', 'lead'],
  },
  social: {
    allowNovelWizard: false,
    subtitle: '为社媒运营公司创建一个新的内容项目',
    initialTaskTitle: '确定目标平台、账号定位与内容计划',
    namePlaceholder: '例如：小红书账号冷启动',
    descriptionPlaceholder: '说明目标平台、内容方向与增长目标（选填）',
    preferredAssigneeRoles: ['planner', 'copywriter', 'operator', 'lead'],
  },
};

export function getProjectCreationPreset(kind: string | undefined): ProjectCreationPreset {
  if (kind && kind in PROJECT_CREATION_PRESETS) {
    return PROJECT_CREATION_PRESETS[kind as keyof typeof PROJECT_CREATION_PRESETS];
  }
  return PROJECT_CREATION_PRESETS.general;
}
