export type CompanyTemplateId = 'general' | 'software' | 'content' | 'novel';

export interface CompanyTemplateOption {
  id: CompanyTemplateId;
  name: string;
  description: string;
  roles: string[];
}

export const COMPANY_TEMPLATE_OPTIONS: CompanyTemplateOption[] = [
  { id: 'general', name: '通用项目公司', description: '适合研究、运营和跨职能工作', roles: ['lead', 'specialist', 'reviewer'] },
  { id: 'software', name: '软件研发公司', description: '适合产品设计、开发和质量验证', roles: ['lead', 'product', 'engineer', 'reviewer'] },
  { id: 'content', name: '内容创作公司', description: '适合策划、创作、编辑和发布', roles: ['lead', 'planner', 'creator', 'editor'] },
  { id: 'novel', name: '长篇小说公司', description: '内置人物、情节和连续性协作流程', roles: ['lead', 'writer', 'character', 'plot', 'inspector'] },
];

export function getCompanyTemplate(id: CompanyTemplateId): CompanyTemplateOption {
  const template = COMPANY_TEMPLATE_OPTIONS.find((item) => item.id === id);
  if (!template) throw new Error(`Unknown company template: ${id}`);
  return template;
}
