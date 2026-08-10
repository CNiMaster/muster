import type {
  CompanyTaskProtocol,
  CompanyTemplateRelationship,
  CompanyTemplateWorkflow,
} from '../../shared/company-template';

export type CompanyTemplateId = 'general' | 'software' | 'content' | 'novel' | 'marketing' | 'consulting' | 'visual' | 'video' | 'publishing' | 'social';

export type { CompanyTaskProtocol, CompanyTemplateRelationship, CompanyTemplateWorkflow };

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
  taskProtocol: CompanyTaskProtocol;
  relationships: {
    org: CompanyTemplateRelationship[];
    communication: CompanyTemplateRelationship[];
  };
  workflow: CompanyTemplateWorkflow;
}

type CompanyTemplateBase = Omit<CompanyTemplate, 'taskProtocol' | 'relationships' | 'workflow'>;

const DEFAULT_TASK_PROTOCOL: CompanyTaskProtocol = {
  version: 1,
  inputFields: ['goal', 'background', 'references', 'acceptance'],
  outputFields: ['summary', 'deliverables', 'risks', 'nextActions'],
};

function withCollaboration(base: CompanyTemplateBase): CompanyTemplate {
  const lead = base.employees.find((employee) => employee.isLead);
  if (!lead) throw new Error(`公司模板 ${base.id} 缺少第一负责人`);
  const handoffProtocol = {
    requestFields: DEFAULT_TASK_PROTOCOL.inputFields,
    responseFields: DEFAULT_TASK_PROTOCOL.outputFields,
    escalationRole: lead.role,
  };
  const org = base.employees
    .filter((employee) => employee.key !== lead.key)
    .map((employee) => ({ sourceKey: lead.key, targetKey: employee.key, label: '直接负责', protocol: handoffProtocol }));
  const communication: CompanyTemplateRelationship[] = [];
  const seen = new Set<string>();
  const connect = (sourceKey: string, targetKey: string, label: string): void => {
    const key = `${sourceKey}:${targetKey}`;
    if (sourceKey === targetKey || seen.has(key)) return;
    seen.add(key);
    communication.push({ sourceKey, targetKey, label, protocol: handoffProtocol });
  };
  for (const employee of base.employees) {
    if (employee.key === lead.key) continue;
    connect(lead.key, employee.key, '可派发');
    connect(employee.key, lead.key, '可上报');
  }
  for (let index = 0; index < base.employees.length - 1; index += 1) {
    connect(base.employees[index]!.key, base.employees[index + 1]!.key, '可交接');
    connect(base.employees[index + 1]!.key, base.employees[index]!.key, '可协商');
  }
  const workflowNodes: CompanyTemplateWorkflow['nodes'] = [
    { key: 'start', kind: 'start', label: '任务进入', position: { x: 40, y: 160 } },
    ...base.employees.map((employee, index) => ({
      key: `employee:${employee.key}`,
      kind: 'step' as const,
      label: employee.name,
      position: { x: 240 + index * 220, y: 160 },
      props: {
        assigneeRole: employee.role,
        title: `${employee.name}处理与交接`,
        inputProtocol: {
          requiredFields: DEFAULT_TASK_PROTOCOL.inputFields,
          goal: employee.responsibilities,
        },
        outputProtocol: {
          requiredFields: DEFAULT_TASK_PROTOCOL.outputFields,
          resultFormat: '提交结论摘要、交付物、风险与阻塞、后续动作',
        },
        priority: 5,
      },
    })),
    { key: 'end', kind: 'end', label: '成果提交', position: { x: 240 + base.employees.length * 220, y: 160 } },
  ];
  const workflowEdges = workflowNodes.slice(0, -1).map((node, index) => ({
    sourceKey: node.key,
    targetKey: workflowNodes[index + 1]!.key,
    label: index === 0 ? '负责人接单' : index === workflowNodes.length - 2 ? '提交成果' : '标准交接',
  }));
  return {
    ...base,
    taskProtocol: { ...DEFAULT_TASK_PROTOCOL, inputFields: [...DEFAULT_TASK_PROTOCOL.inputFields], outputFields: [...DEFAULT_TASK_PROTOCOL.outputFields] },
    relationships: { org, communication },
    workflow: { nodes: workflowNodes, edges: workflowEdges },
  };
}

const TEMPLATE_BASES: Record<CompanyTemplateId, CompanyTemplateBase> = {
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
  marketing: {
    id: 'marketing', name: '品牌营销公司', description: '适合市场调研、公关传播与增长推广',
    departments: [{ key: 'strategy', name: '策略部' }, { key: 'creative', name: '创意部' }, { key: 'growth', name: '增长部' }],
    employees: [
      { key: 'lead', name: '营销总监', role: 'lead', responsibilities: '制定品牌战略、调配资源并把控传播节奏', departmentKey: 'strategy', isLead: true },
      { key: 'analyst', name: '市场分析师', role: 'analyst', responsibilities: '调研竞品、分析目标受众与洞察市场趋势', departmentKey: 'strategy' },
      { key: 'copywriter', name: '文案创意师', role: 'copywriter', responsibilities: '撰写品牌文案、活动策划案与宣传素材', departmentKey: 'creative' },
      { key: 'pr_specialist', name: '公关专家', role: 'pr_specialist', responsibilities: '对接媒体、起草公关稿件与维护品牌声誉', departmentKey: 'growth' },
    ],
    projectName: '首个营销企划', firstTaskTitle: '分析目标受众并撰写整合营销方案',
  },
  consulting: {
    id: 'consulting', name: '行业咨询公司', description: '适合行业研报、竞争分析与战略咨询',
    departments: [{ key: 'research', name: '研究部' }, { key: 'analytics', name: '分析部' }, { key: 'editorial', name: '主编部' }],
    employees: [
      { key: 'lead', name: '研报总监', role: 'lead', responsibilities: '定义研究课题、搭建分析框架与审阅最终报告', departmentKey: 'research', isLead: true },
      { key: 'expert', name: '行业专家', role: 'expert', responsibilities: '深度访谈、行业趋势洞察与战略建议提炼', departmentKey: 'research' },
      { key: 'data_analyst', name: '数据分析师', role: 'data_analyst', responsibilities: '收集海量行业数据、搭建定量模型与图标绘制', departmentKey: 'analytics' },
      { key: 'editor', name: '报告总编辑', role: 'editor', responsibilities: '校对报告逻辑、润色文字并排版最终 PDF/Doc 成果', departmentKey: 'editorial' },
    ],
    projectName: '首份行业咨询报告', firstTaskTitle: '确定研究课题与分析框架',
  },
  // ===== 阶段六任务 6.1：多类型公司模板 =====
  visual: {
    id: 'visual', name: '图片制作公司', description: '适合插画、平面设计、AI 绘图与视觉素材制作',
    departments: [{ key: 'creative', name: '创意部' }, { key: 'production', name: '制作部' }, { key: 'quality', name: '质量部' }],
    employees: [
      { key: 'lead', name: '创意总监', role: 'lead', responsibilities: '确定创意方向、风格基调并做最终创意把关', departmentKey: 'creative', isLead: true },
      { key: 'designer', name: '平面设计师', role: 'designer', responsibilities: '产出海报、主视觉与品牌物料设计稿', departmentKey: 'creative' },
      { key: 'illustrator', name: '插画师', role: 'illustrator', responsibilities: '创作原创插画、角色设定与场景绘制', departmentKey: 'production' },
      { key: 'ai_engineer', name: 'AI 绘图工程师', role: 'ai_engineer', responsibilities: '用提示词工程稳定产出高质量 AI 图像并筛选修复', departmentKey: 'production' },
      { key: 'retoucher', name: '修图师', role: 'retoucher', responsibilities: '图像精修、调色与合成处理', departmentKey: 'production' },
      { key: 'reviewer', name: '视觉质量审核员', role: 'reviewer', responsibilities: '对照品牌规范与技术标准审核视觉交付物', departmentKey: 'quality' },
    ],
    projectName: '首个视觉项目', firstTaskTitle: '明确视觉需求与创意方向',
  },
  video: {
    id: 'video', name: '影视制作公司', description: '适合脚本、分镜、剪辑与成片制作',
    departments: [{ key: 'planning', name: '策划部' }, { key: 'production', name: '制作部' }, { key: 'post', name: '后期部' }],
    employees: [
      { key: 'lead', name: '制片人', role: 'lead', responsibilities: '统筹项目立项、排期、预算与交付验收', departmentKey: 'planning', isLead: true },
      { key: 'screenwriter', name: '编剧', role: 'screenwriter', responsibilities: '创作剧本、故事大纲与短视频脚本', departmentKey: 'planning' },
      { key: 'director', name: '导演', role: 'director', responsibilities: '设计镜头语言、指导拍摄并把控叙事', departmentKey: 'production' },
      { key: 'storyboard', name: '分镜师', role: 'storyboard', responsibilities: '将脚本转化为分镜画面与镜头列表', departmentKey: 'production' },
      { key: 'editor', name: '剪辑师', role: 'editor', responsibilities: '粗剪精剪、把控节奏与叙事结构', departmentKey: 'post' },
      { key: 'colorist', name: '调色师', role: 'colorist', responsibilities: '影片调色、色彩风格与画面统一', departmentKey: 'post' },
      { key: 'synthesist', name: '后期合成师', role: 'synthesist', responsibilities: '特效合成、包装与最终成片整合', departmentKey: 'post' },
    ],
    projectName: '首个视频项目', firstTaskTitle: '明确视频目标、受众与脚本方向',
  },
  publishing: {
    id: 'publishing', name: '编辑出版公司', description: '适合选题策划、编辑校对与出版发行',
    departments: [{ key: 'planning', name: '策划部' }, { key: 'editing', name: '编辑部' }, { key: 'review', name: '校审部' }],
    employees: [
      { key: 'lead', name: '主编', role: 'lead', responsibilities: '制定内容方向、分配选题并做终审把关', departmentKey: 'planning', isLead: true },
      { key: 'planner', name: '策划编辑', role: 'planner', responsibilities: '选题策划、内容规划与作者协调', departmentKey: 'planning' },
      { key: 'editor', name: '文字编辑', role: 'editor', responsibilities: '稿件结构优化、语言打磨与一致性核对', departmentKey: 'editing' },
      { key: 'fact_checker', name: '事实核查员', role: 'fact_checker', responsibilities: '核查事实、数据与引用出处', departmentKey: 'review' },
      { key: 'proofreader', name: '校对员', role: 'proofreader', responsibilities: '错别字、标点、格式与规范校对', departmentKey: 'review' },
      { key: 'layout', name: '排版设计师', role: 'layout', responsibilities: '版式设计与印前处理', departmentKey: 'editing' },
    ],
    projectName: '首个出版项目', firstTaskTitle: '确定选题方向与内容规划',
  },
  social: {
    id: 'social', name: '社媒运营公司', description: '适合小红书、抖音、B 站等内容发布与账号运营',
    departments: [{ key: 'planning', name: '策划部' }, { key: 'creation', name: '创作部' }, { key: 'operation', name: '运营部' }],
    employees: [
      { key: 'lead', name: '运营总监', role: 'lead', responsibilities: '制定账号内容策略、发布节奏与增长目标', departmentKey: 'planning', isLead: true },
      { key: 'planner', name: '内容策划', role: 'planner', responsibilities: '选题策划、平台适配与排期规划', departmentKey: 'planning' },
      { key: 'copywriter', name: '文案写手', role: 'copywriter', responsibilities: '撰写标题、正文与爆款钩子文案', departmentKey: 'creation' },
      { key: 'cover_designer', name: '封面设计师', role: 'cover_designer', responsibilities: '设计各平台封面与视觉素材', departmentKey: 'creation' },
      { key: 'operator', name: '平台运营专员', role: 'operator', responsibilities: '发布、互动、评论维护与社群运营', departmentKey: 'operation' },
      { key: 'analyst', name: '数据分析师', role: 'analyst', responsibilities: '数据监控、效果分析与策略优化', departmentKey: 'operation' },
    ],
    projectName: '首个社媒项目', firstTaskTitle: '确定目标平台、账号定位与内容计划',
  },
};

export const BUILTIN_COMPANY_TEMPLATES: Record<CompanyTemplateId, CompanyTemplate> = {
  general: withCollaboration(TEMPLATE_BASES.general),
  software: withCollaboration(TEMPLATE_BASES.software),
  content: withCollaboration(TEMPLATE_BASES.content),
  novel: withCollaboration(TEMPLATE_BASES.novel),
  marketing: withCollaboration(TEMPLATE_BASES.marketing),
  consulting: withCollaboration(TEMPLATE_BASES.consulting),
  visual: withCollaboration(TEMPLATE_BASES.visual),
  video: withCollaboration(TEMPLATE_BASES.video),
  publishing: withCollaboration(TEMPLATE_BASES.publishing),
  social: withCollaboration(TEMPLATE_BASES.social),
};

export function getBuiltinCompanyTemplate(id: CompanyTemplateId): CompanyTemplate {
  return BUILTIN_COMPANY_TEMPLATES[id];
}
