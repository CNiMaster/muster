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

const PROJECT_CREATION_PRESETS: Record<'general' | 'software' | 'content' | 'novel' | 'marketing' | 'consulting', ProjectCreationPreset> = {
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
};

export function getProjectCreationPreset(kind: string | undefined): ProjectCreationPreset {
  if (kind && kind in PROJECT_CREATION_PRESETS) {
    return PROJECT_CREATION_PRESETS[kind as keyof typeof PROJECT_CREATION_PRESETS];
  }
  return PROJECT_CREATION_PRESETS.general;
}
