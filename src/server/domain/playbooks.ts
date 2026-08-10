/**
 * 项目 Playbook（阶段六任务 6.2）。
 *
 * 同一家公司可运行不同类型的项目（如内容公司同时跑小红书图文与长篇专栏），
 * 不同项目对应不同的阶段定义、成果类型与审批节点。
 * Playbook 是项目级元数据（project.playbook_id），目录在此静态定义，
 * 后续可扩展为公司级自定义 Playbook。
 */

export interface PlaybookPhase {
  key: string;
  label: string;
  /** 该阶段的交付物类型（对应 artifactTypes 的 key）。 */
  deliverables: string[];
  /** 是否需要人工确认才能进入下一阶段。 */
  approvalGate: boolean;
}

export interface ProjectPlaybook {
  id: string;
  name: string;
  description: string;
  /** 适用公司模板（general = 通用）。 */
  companyTemplateIds: string[];
  phases: PlaybookPhase[];
  artifactTypes: string[];
}

/** 内置 Playbook 目录。 */
const PLAYBOOKS: ProjectPlaybook[] = [
  {
    id: 'software-feature',
    name: '软件功能迭代',
    description: '需求梳理 → 实现 → 测试 → 发布的标准软件交付节奏',
    companyTemplateIds: ['software', 'general'],
    artifactTypes: ['requirements_doc', 'code_change', 'test_report', 'release'],
    phases: [
      { key: 'requirements', label: '需求梳理', deliverables: ['requirements_doc'], approvalGate: true },
      { key: 'implementation', label: '实现开发', deliverables: ['code_change'], approvalGate: false },
      { key: 'testing', label: '测试验证', deliverables: ['test_report'], approvalGate: true },
      { key: 'release', label: '发布上线', deliverables: ['release'], approvalGate: true },
    ],
  },
  {
    id: 'novel-chapter',
    name: '小说章节创作',
    description: '大纲 → 章节写作 → 连续性检查 → 定稿的小说创作节奏',
    companyTemplateIds: ['novel'],
    artifactTypes: ['chapter_text', 'character_cards', 'plot_timeline'],
    phases: [
      { key: 'outline', label: '大纲规划', deliverables: ['plot_timeline'], approvalGate: true },
      { key: 'writing', label: '章节写作', deliverables: ['chapter_text'], approvalGate: false },
      { key: 'continuity', label: '连续性检查', deliverables: ['character_cards'], approvalGate: true },
      { key: 'finalize', label: '定稿', deliverables: ['chapter_text'], approvalGate: true },
    ],
  },
  {
    id: 'image-campaign',
    name: '视觉素材制作',
    description: '创意方向 → 制作 → 质量审核 → 交付的视觉制作节奏',
    companyTemplateIds: ['visual', 'marketing', 'general'],
    artifactTypes: ['design_deliverable', 'ai_image_set'],
    phases: [
      { key: 'direction', label: '创意方向', deliverables: ['design_deliverable'], approvalGate: true },
      { key: 'production', label: '素材制作', deliverables: ['design_deliverable', 'ai_image_set'], approvalGate: false },
      { key: 'quality', label: '质量审核', deliverables: ['design_deliverable'], approvalGate: true },
      { key: 'delivery', label: '交付', deliverables: ['design_deliverable'], approvalGate: true },
    ],
  },
  {
    id: 'short-video',
    name: '短视频制作',
    description: '脚本 → 拍摄/素材 → 剪辑后期 → 成片交付的视频制作节奏',
    companyTemplateIds: ['video', 'social', 'marketing'],
    artifactTypes: ['script_doc', 'final_cut'],
    phases: [
      { key: 'script', label: '脚本策划', deliverables: ['script_doc'], approvalGate: true },
      { key: 'production', label: '素材制作', deliverables: ['final_cut'], approvalGate: false },
      { key: 'post', label: '剪辑后期', deliverables: ['final_cut'], approvalGate: false },
      { key: 'delivery', label: '成片交付', deliverables: ['final_cut'], approvalGate: true },
    ],
  },
  {
    id: 'social-post',
    name: '社媒内容发布',
    description: '选题 → 创作 → 平台适配 → 发布复盘的内容发布节奏',
    companyTemplateIds: ['social', 'content', 'marketing'],
    artifactTypes: ['social_content'],
    phases: [
      { key: 'topic', label: '选题策划', deliverables: ['social_content'], approvalGate: true },
      { key: 'creation', label: '内容创作', deliverables: ['social_content'], approvalGate: false },
      { key: 'adaptation', label: '平台适配', deliverables: ['social_content'], approvalGate: true },
      { key: 'publish', label: '发布与复盘', deliverables: ['social_content'], approvalGate: true },
    ],
  },
  {
    id: 'editorial-article',
    name: '深度内容编辑',
    description: '选题 → 初稿 → 编辑校对 → 定稿发布的长内容编辑节奏',
    companyTemplateIds: ['publishing', 'content', 'general'],
    artifactTypes: ['final_manuscript', 'layout_file'],
    phases: [
      { key: 'topic', label: '选题策划', deliverables: ['final_manuscript'], approvalGate: true },
      { key: 'draft', label: '初稿写作', deliverables: ['final_manuscript'], approvalGate: false },
      { key: 'editing', label: '编辑校对', deliverables: ['final_manuscript'], approvalGate: true },
      { key: 'finalize', label: '定稿发布', deliverables: ['final_manuscript', 'layout_file'], approvalGate: true },
    ],
  },
];

/** 列出全部 Playbook。 */
export function listPlaybooks(): ProjectPlaybook[] {
  return structuredClone(PLAYBOOKS);
}

/** 按 id 取 Playbook；不存在返回 null。 */
export function getPlaybook(id: string): ProjectPlaybook | null {
  const playbook = PLAYBOOKS.find((p) => p.id === id);
  return playbook ? structuredClone(playbook) : null;
}

/** 按公司模板 id 推荐 Playbook（无匹配返回通用目录）。 */
export function playbooksForCompanyTemplate(templateId: string): ProjectPlaybook[] {
  const matched = PLAYBOOKS.filter((p) => p.companyTemplateIds.includes(templateId));
  return structuredClone(matched.length > 0 ? matched : PLAYBOOKS.filter((p) => p.companyTemplateIds.includes('general')));
}
