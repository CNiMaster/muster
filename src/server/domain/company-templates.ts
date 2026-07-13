export type CompanyTemplateId = 'general' | 'software' | 'content' | 'novel';

export interface CompanyTemplateRole {
  key: string;
  name: string;
  role: string;
  responsibilities: string;
  departmentKey: string;
  isLead?: boolean;
}

export interface CompanyTemplate {
  id: CompanyTemplateId;
  name: string;
  description: string;
  departments: Array<{ key: string; name: string }>;
  employees: CompanyTemplateRole[];
  projectName: string;
  firstTaskTitle: string;
}

export const BUILTIN_COMPANY_TEMPLATES: Record<CompanyTemplateId, CompanyTemplate> = {
  general: {
    id: 'general', name: '通用项目公司', description: '适合研究、运营和跨职能工作',
    departments: [{ key: 'delivery', name: '执行部' }, { key: 'quality', name: '质量部' }],
    employees: [
      { key: 'lead', name: '项目负责人', role: 'lead', responsibilities: '拆解目标、分配工作并对最终结果负责', departmentKey: 'delivery', isLead: true },
      { key: 'specialist', name: '执行专家', role: 'specialist', responsibilities: '完成核心专业工作并沉淀成果', departmentKey: 'delivery' },
      { key: 'reviewer', name: '质量审查员', role: 'reviewer', responsibilities: '验证成果、识别风险并提出修正意见', departmentKey: 'quality' },
    ],
    projectName: '首个项目', firstTaskTitle: '明确目标并制定执行方案',
  },
  software: {
    id: 'software', name: '软件研发公司', description: '适合产品设计、开发和质量验证',
    departments: [{ key: 'product', name: '产品部' }, { key: 'engineering', name: '工程部' }, { key: 'quality', name: '质量部' }],
    employees: [
      { key: 'lead', name: '研发负责人', role: 'lead', responsibilities: '统筹需求、架构和交付风险', departmentKey: 'engineering', isLead: true },
      { key: 'product', name: '产品经理', role: 'product', responsibilities: '澄清用户问题、定义范围和验收标准', departmentKey: 'product' },
      { key: 'engineer', name: '软件工程师', role: 'engineer', responsibilities: '实现、测试并维护产品代码', departmentKey: 'engineering' },
      { key: 'reviewer', name: '质量工程师', role: 'reviewer', responsibilities: '审查实现并完成回归验证', departmentKey: 'quality' },
    ],
    projectName: '首个软件项目', firstTaskTitle: '梳理需求并建立可交付的实施计划',
  },
  content: {
    id: 'content', name: '内容创作公司', description: '适合策划、创作、编辑和发布',
    departments: [{ key: 'planning', name: '策划部' }, { key: 'creation', name: '创作部' }, { key: 'editing', name: '编辑部' }],
    employees: [
      { key: 'lead', name: '内容负责人', role: 'lead', responsibilities: '确定内容方向、节奏和质量标准', departmentKey: 'planning', isLead: true },
      { key: 'planner', name: '内容策划', role: 'planner', responsibilities: '研究受众并制定选题和内容结构', departmentKey: 'planning' },
      { key: 'creator', name: '内容创作者', role: 'creator', responsibilities: '根据策划完成内容初稿和素材', departmentKey: 'creation' },
      { key: 'editor', name: '编辑', role: 'editor', responsibilities: '编辑、校验并准备发布版本', departmentKey: 'editing' },
    ],
    projectName: '首个内容项目', firstTaskTitle: '确定受众、主题与内容计划',
  },
  novel: {
    id: 'novel', name: '长篇小说公司', description: '适合人物、情节和连续性协作',
    departments: [{ key: 'creation', name: '创作部' }, { key: 'world', name: '设定部' }, { key: 'quality', name: '监察部' }],
    employees: [
      { key: 'lead', name: '主编', role: 'lead', responsibilities: '统筹作品方向、章节计划和团队协作', departmentKey: 'creation', isLead: true },
      { key: 'writer', name: '正文作者', role: 'writer', responsibilities: '完成小说正文和章节修订', departmentKey: 'creation' },
      { key: 'character', name: '人物设计师', role: 'character', responsibilities: '维护人物弧光、关系和行为一致性', departmentKey: 'world' },
      { key: 'plot', name: '情节设计师', role: 'plot', responsibilities: '维护主线、伏笔和章节节奏', departmentKey: 'world' },
      { key: 'inspector', name: '连续性监察员', role: 'inspector', responsibilities: '检查设定、时间线和前后文冲突', departmentKey: 'quality' },
    ],
    projectName: '首部长篇作品', firstTaskTitle: '明确题材、读者与故事核心',
  },
};

export function getBuiltinCompanyTemplate(id: CompanyTemplateId): CompanyTemplate {
  return BUILTIN_COMPANY_TEMPLATES[id];
}
