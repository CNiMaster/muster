export type RecruitmentSource = 'reuse-profile' | 'new-profile' | 'role-template';

export interface RecruitmentDraft {
  source: RecruitmentSource;
  profileId?: string;
  displayName: string;
  role: string;
  responsibilities: string;
  capabilities: { skills: string[]; tools: string[] };
  departmentId: string | null;
  executorProfileId: string | null;
  permissionPolicyId: string | null;
}

export interface RoleTemplate {
  id: string;
  name: string;
  role: string;
  responsibilities: string;
  skills: string[];
  tools: string[];
}

export interface EmployeeTemplatePack {
  id: 'general' | 'software' | 'content' | 'novel';
  name: string;
  mark: string;
  description: string;
  roles: Array<{ templateId: string; displayName: string }>;
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  { id: 'lead', name: '负责人', role: 'lead', responsibilities: '拆解目标、分配工作、处理阻塞并对最终结果负责', skills: ['planning', 'delegation', 'review'], tools: [] },
  { id: 'product', name: '产品经理', role: 'product', responsibilities: '研究用户、定义范围和验收标准', skills: ['product-discovery', 'requirements'], tools: [] },
  { id: 'engineer', name: '工程师', role: 'engineer', responsibilities: '实现、测试和维护技术成果', skills: ['implementation', 'testing'], tools: ['filesystem', 'terminal'] },
  { id: 'researcher', name: '研究员', role: 'researcher', responsibilities: '收集证据、分析问题并形成可追溯结论', skills: ['research', 'analysis'], tools: ['web'] },
  { id: 'planner', name: '内容策划', role: 'planner', responsibilities: '确定受众、选题、结构和发布计划', skills: ['content-planning'], tools: [] },
  { id: 'creator', name: '创作者', role: 'creator', responsibilities: '根据目标和素材完成内容初稿', skills: ['writing', 'creation'], tools: [] },
  { id: 'editor', name: '编辑', role: 'editor', responsibilities: '编辑、校验并整理可发布成果', skills: ['editing', 'fact-checking'], tools: [] },
  { id: 'reviewer', name: '质量审查', role: 'reviewer', responsibilities: '检查成果质量、风险和验收标准', skills: ['review', 'testing'], tools: [] },
  { id: 'inspector', name: '运营监察', role: 'inspector', responsibilities: '监控运行状态、发现遗漏并升级风险', skills: ['monitoring', 'risk-control'], tools: [] },
  { id: 'specialist', name: '执行专家', role: 'specialist', responsibilities: '完成核心专业工作并沉淀可复用成果', skills: ['analysis', 'delivery'], tools: [] },
  { id: 'writer', name: '正文作者', role: 'writer', responsibilities: '完成小说正文、章节衔接和迭代修订', skills: ['writing', 'storytelling'], tools: [] },
  { id: 'character', name: '人物设计师', role: 'character', responsibilities: '维护人物弧光、关系和行为一致性', skills: ['character-design', 'continuity'], tools: [] },
  { id: 'plot', name: '情节设计师', role: 'plot', responsibilities: '维护主线、伏笔、冲突和章节节奏', skills: ['plot-design', 'story-structure'], tools: [] },
];

export const EMPLOYEE_TEMPLATE_PACKS: EmployeeTemplatePack[] = [
  { id: 'general', name: '通用项目团队', mark: '通', description: '目标拆解、专业执行、质量把关', roles: [{ templateId: 'lead', displayName: '项目负责人' }, { templateId: 'specialist', displayName: '执行专家' }, { templateId: 'reviewer', displayName: '质量审查员' }] },
  { id: 'software', name: '软件研发团队', mark: '码', description: '产品、研发、测试完整交付', roles: [{ templateId: 'lead', displayName: '研发负责人' }, { templateId: 'product', displayName: '产品经理' }, { templateId: 'engineer', displayName: '软件工程师' }, { templateId: 'reviewer', displayName: '质量工程师' }] },
  { id: 'content', name: '内容创作团队', mark: '创', description: '策划、创作、编辑协同发布', roles: [{ templateId: 'lead', displayName: '内容负责人' }, { templateId: 'planner', displayName: '内容策划' }, { templateId: 'creator', displayName: '内容创作者' }, { templateId: 'editor', displayName: '编辑' }] },
  { id: 'novel', name: '长篇小说团队', mark: '文', description: '正文、人物、情节与连续性协作', roles: [{ templateId: 'lead', displayName: '主编' }, { templateId: 'writer', displayName: '正文作者' }, { templateId: 'character', displayName: '人物设计师' }, { templateId: 'plot', displayName: '情节设计师' }, { templateId: 'inspector', displayName: '连续性监察员' }] },
];
