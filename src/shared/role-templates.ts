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
];
