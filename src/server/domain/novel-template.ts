/**
 * 长篇小说公司模板：生成员工、关系、协议、流程。
 *
 基础岗位：项目第一负责人、主写手、人物设计、情节架构、运营监察。
 约束：第一负责人与主写手禁止由同一员工兼任。
 题材扩展包（PRD:438）：按 genres 追加可选岗位（世界观/时间线/伏笔/连续性/文风等）。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { createCompany, updateCompany } from './company';
import { createAgent } from './agent';
import { addRelationship } from './graph';
import type { Company } from './company';
import type { AgentDefinition } from './agent';
import { listAgents } from './agent';
import { initializeArtifactContent } from './artifact-content';
import type { Artifact, ArtifactKind } from './artifact';
import { getProject } from './project';
import { createDepartment, type Department } from './department';

/** 题材扩展包定义：额外岗位 + 额外初始成果。 */
export interface GenrePack {
  name: string;
  label: string;
  /** 追加的可选岗位。 */
  extraRoles: Array<{
    role: string;
    name: string;
    responsibilities: string;
    /** 关联的维护类 artifact kind（用于初始化成果归属）。 */
    ownerArtifactKinds?: ArtifactKind[];
  }>;
  /** 追加的初始成果（kind/path/content）。 */
  extraArtifacts?: Array<{
    path: string;
    kind: ArtifactKind;
    ownerRole: string;
    content: string;
  }>;
}

/**
 预置题材扩展包（PRD:438-446）。
 - scifi：世界观架构师（管理 worldbuilding）
 - romance：情感设计师（管理人物情感线，归入 character_sheet）
 - mystery：伏笔管理员（管理 foreshadowing）
 - historical：考据员（管理 timeline + worldbuilding）
 - fantasy：世界观+伏笔（综合）
 - continuity（可叠加）：连续性检查员（独立于基础 inspector）
 - style（可叠加）：文风审校（管理 style_profile）
 */
export const GENRE_EXTENSION_PACKS: Record<string, GenrePack> = {
  scifi: {
    name: 'scifi',
    label: '科幻',
    extraRoles: [
      {
        role: 'worldview',
        name: '世界观架构师',
        responsibilities: '维护科幻设定、技术体系、物理规则一致性。',
        ownerArtifactKinds: ['worldbuilding'],
      },
    ],
    extraArtifacts: [
      { path: 'canon/worldbuilding.md', kind: 'worldbuilding', ownerRole: 'worldview', content: '# 世界观\n\n科幻设定随项目逐步建立。\n' },
    ],
  },
  fantasy: {
    name: 'fantasy',
    label: '奇幻',
    extraRoles: [
      {
        role: 'worldview',
        name: '世界观架构师',
        responsibilities: '维护魔法体系、种族设定、世界规则。',
        ownerArtifactKinds: ['worldbuilding'],
      },
      {
        role: 'foreshadowing',
        name: '伏笔管理员',
        responsibilities: '管理伏笔埋设、推进与回收状态。',
        ownerArtifactKinds: ['foreshadowing'],
      },
    ],
    extraArtifacts: [
      { path: 'canon/worldbuilding.md', kind: 'worldbuilding', ownerRole: 'worldview', content: '# 世界观\n\n奇幻设定随项目逐步建立。\n' },
    ],
  },
  romance: {
    name: 'romance',
    label: '言情',
    extraRoles: [
      {
        role: 'relationship',
        name: '情感设计师',
        responsibilities: '维护人物情感线与关系发展节奏。',
        ownerArtifactKinds: ['character_sheet'],
      },
    ],
  },
  mystery: {
    name: 'mystery',
    label: '悬疑',
    extraRoles: [
      {
        role: 'foreshadowing',
        name: '伏笔管理员',
        responsibilities: '管理线索埋设、悬念推进与真相揭晓节奏。',
        ownerArtifactKinds: ['foreshadowing'],
      },
    ],
  },
  historical: {
    name: 'historical',
    label: '历史',
    extraRoles: [
      {
        role: 'worldview',
        name: '考据员',
        responsibilities: '维护历史背景、年代设定、史实一致性。',
        ownerArtifactKinds: ['worldbuilding', 'timeline'],
      },
    ],
    extraArtifacts: [
      { path: 'canon/worldbuilding.md', kind: 'worldbuilding', ownerRole: 'worldview', content: '# 历史背景\n\n随项目逐步建立。\n' },
    ],
  },
  /** 可叠加：连续性检查员（独立于基础 inspector，专注跨章节一致性）。 */
  continuity: {
    name: 'continuity',
    label: '连续性强化',
    extraRoles: [
      {
        role: 'continuity',
        name: '连续性检查员',
        responsibilities: '检查跨章节人物、时间线、伏笔、设定的连续性，发现问题派发修正 Task。',
      },
    ],
  },
  /** 可叠加：文风审校。 */
  style: {
    name: 'style',
    label: '文风审校',
    extraRoles: [
      {
        role: 'style',
        name: '文风审校',
        responsibilities: '维护文风档案，审校章节文风一致性。',
        ownerArtifactKinds: ['style_profile'],
      },
    ],
  },
};

/** 维护类岗位白名单（章节完成时派发维护 Task 的目标，PRD:458）。 */
export const MAINTENANCE_ROLES = [
  'character',
  'plot',
  'worldview',
  'timeline',
  'foreshadowing',
  'continuity',
  'style',
  'relationship',
];

export interface NovelTemplateInput {
  name: string;
  charter?: string;
  /** 默认风格、题材等元信息。 */
  meta?: Record<string, unknown>;
  departments?: Array<{ name: string; purpose?: string }>;
  /** 题材扩展包 id 列表（如 ['scifi','continuity']），按需追加可选岗位。 */
  genres?: string[];
}

export interface NovelTemplateResult {
  company: Company;
  departments: Department[];
  agents: {
    lead: AgentDefinition;
    writer: AgentDefinition;
    character: AgentDefinition;
    plot: AgentDefinition;
    inspector: AgentDefinition;
    /** 题材扩展包追加的可选岗位。 */
    extra: AgentDefinition[];
  };
}

export function createNovelCompany(db: DB, input: NovelTemplateInput): NovelTemplateResult {
  const company = createCompany(db, {
    name: input.name,
    kind: 'novel',
    charter: input.charter ?? defaultCharter(input.name),
  });
  const departmentInputs = input.departments?.length
    ? input.departments
    : [
        { name: '创作部', purpose: '正文、人物与情节协作' },
        { name: '运营监察', purpose: '进度、拥堵与一致性检查' },
      ];
  const departments = departmentInputs.map((department) => createDepartment(db, {
    companyId: company.id,
    name: department.name,
    rules: { purpose: department.purpose ?? '' },
  }));
  const creativeDepartmentId = departments[0]?.id;
  const inspectorDepartmentId = departments[1]?.id ?? creativeDepartmentId;

  const lead = createAgent(db, {
    companyId: company.id,
    departmentId: creativeDepartmentId,
    name: '项目第一负责人',
    role: 'lead',
    responsibilities: '拆解当前阶段工作并派发 Task；将用户纠正转为修正 Task；汇总项目轮次进展。',
    contactAllow: [], // 稍后补
    canDispatch: true,
  });
  const writer = createAgent(db, {
    companyId: company.id,
    departmentId: creativeDepartmentId,
    name: '主写手',
    role: 'writer',
    responsibilities: '撰写小说章节正文；提交章节变更摘要。',
    contactAllow: [],
    canDispatch: false,
  });
  const character = createAgent(db, {
    companyId: company.id,
    departmentId: creativeDepartmentId,
    name: '人物设计',
    role: 'character',
    responsibilities: '维护人物档案、人物关系设定。',
    contactAllow: [],
  });
  const plot = createAgent(db, {
    companyId: company.id,
    departmentId: creativeDepartmentId,
    name: '情节架构',
    role: 'plot',
    responsibilities: '维护可编辑计划大纲、伏笔资料、剧情进度。',
    contactAllow: [],
  });
  const inspector = createAgent(db, {
    companyId: company.id,
    departmentId: inspectorDepartmentId,
    name: '运营监察',
    role: 'inspector',
    responsibilities: '观察拥堵、缺席、死循环；建议扩容；不得自动改组织。',
    contactAllow: [],
    canDispatch: false,
    isInspector: true,
  });

  // 题材扩展包：按 genres 追加可选岗位（PRD:438-446）
  const extra: AgentDefinition[] = [];
  const seenRoles = new Set(['lead', 'writer', 'character', 'plot', 'inspector']);
  for (const genreId of input.genres ?? []) {
    const pack = GENRE_EXTENSION_PACKS[genreId];
    if (!pack) continue;
    for (const r of pack.extraRoles) {
      if (seenRoles.has(r.role)) continue; // 去重：同一 role 只创建一次
      seenRoles.add(r.role);
      // continuity 归属监察部，其余归创作部
      const deptId = r.role === 'continuity' ? inspectorDepartmentId : creativeDepartmentId;
      const ag = createAgent(db, {
        companyId: company.id,
        departmentId: deptId,
        name: r.name,
        role: r.role,
        responsibilities: r.responsibilities,
        contactAllow: [],
      });
      extra.push(ag);
    }
  }

  // 设第一负责人（刷新 company 对象）
  const updatedCompany = updateCompany(db, company.id, { firstAgentId: lead.id });

  // 组织关系：lead 管理所有（基础 + 扩展）
  for (const a of [writer, character, plot, inspector, ...extra]) {
    addRelationship(db, { companyId: company.id, kind: 'org', sourceId: lead.id, targetId: a.id, label: '管辖' });
  }
  // 通信关系：lead 可联系所有人；writer 可联系所有创作类岗位（求助资料）
  const creativeExtras = extra.filter((e) => e.role !== 'continuity');
  lead.contactAllow = [writer.id, character.id, plot.id, inspector.id, ...extra.map((e) => e.id)];
  writer.contactAllow = [character.id, plot.id, lead.id, ...creativeExtras.map((e) => e.id)];
  character.contactAllow = [lead.id, writer.id];
  plot.contactAllow = [lead.id, writer.id];
  for (const e of extra) {
    e.contactAllow = e.role === 'continuity' ? [lead.id, inspector.id] : [lead.id, writer.id];
  }
  // update agent contact_allow
  for (const a of [lead, writer, character, plot, inspector, ...extra] as AgentDefinition[]) {
    db.prepare('UPDATE agent_definition SET contact_allow_json=? WHERE id=?').run(JSON.stringify(a.contactAllow), a.id);
  }
  // 通信图边
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: lead.id, targetId: writer.id, label: '派发' });
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: writer.id, targetId: character.id, label: '求人物资料' });
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: writer.id, targetId: plot.id, label: '求情节资料' });
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: inspector.id, targetId: lead.id, label: '告警' });
  for (const e of creativeExtras) {
    addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: writer.id, targetId: e.id, label: '求资料' });
  }

  return { company: updatedCompany, departments, agents: { lead, writer, character, plot, inspector, extra } };
}

/** 校验：第一负责人与主写手不可同一人。 */
export function assertLeadWriterSeparate(leadId: string, writerId: string): void {
  if (leadId === writerId) {
    throw new AppError(ErrorCode.AGENT_ROLE_CONFLICT, '项目第一负责人与主写手必须由不同员工担任');
  }
}

/** 创建长篇小说项目的渐进式基础成果。幂等，不覆盖已有内容。 */
export function initializeNovelProject(db: DB, projectId: string): Artifact[] {
  const project = getProject(db, projectId);
  const agents = listAgents(db, project.companyId);
  const owner = (role: string): string | undefined => agents.find((agent) => agent.role === role)?.id;
  const hasRole = (role: string): boolean => agents.some((agent) => agent.role === role);
  // 若存在专门岗位，则把对应成果归属给它；否则回退到 plot/writer
  const worldbuildingOwner = hasRole('worldview') ? 'worldview' : 'plot';
  const timelineOwner = hasRole('timeline') ? 'timeline' : 'plot';
  const foreshadowingOwner = hasRole('foreshadowing') ? 'foreshadowing' : 'plot';
  const styleOwner = hasRole('style') ? 'style' : 'writer';
  const characterOwner = hasRole('relationship') ? 'relationship' : 'character';
  const definitions: Array<{
    path: string;
    kind: ArtifactKind;
    ownerRole: string;
    content: string;
  }> = [
    { path: 'project/brief.md', kind: 'project_brief', ownerRole: 'lead', content: `# ${project.name}\n\n${project.description || '等待第一负责人根据初始任务逐步完善。'}\n` },
    { path: 'planning/synopsis.md', kind: 'synopsis', ownerRole: 'lead', content: '# 故事梗概\n\n等待项目规划。\n' },
    { path: 'planning/style-profile.md', kind: 'style_profile', ownerRole: styleOwner, content: '# 文风档案\n\n等待用户与主写手共同确认。\n' },
    { path: 'planning/outline.md', kind: 'outline', ownerRole: 'plot', content: '# 计划大纲\n\n按创作进度滚动展开。\n' },
    { path: 'canon/characters.md', kind: 'character_sheet', ownerRole: characterOwner, content: '# 人物档案\n\n随章节进展维护。\n' },
    { path: 'canon/worldbuilding.md', kind: 'worldbuilding', ownerRole: worldbuildingOwner, content: '# 世界观\n\n随项目需要逐步建立。\n' },
    { path: 'canon/timeline.md', kind: 'timeline', ownerRole: timelineOwner, content: '# 时间线资料\n\n随章节进展维护。\n' },
    { path: 'canon/foreshadowing.md', kind: 'foreshadowing', ownerRole: foreshadowingOwner, content: '# 伏笔资料\n\n记录埋设、推进与回收状态。\n' },
    { path: 'views/character-relations.md', kind: 'character_relation_view', ownerRole: 'character', content: '# 人物关系（派生只读）\n\n尚无已发生关系。\n' },
    { path: 'views/plot-progress.md', kind: 'plot_progress_view', ownerRole: 'plot', content: '# 实际剧情进度（派生只读）\n\n尚无已完成章节。\n' },
    { path: 'views/timeline.md', kind: 'timeline_view', ownerRole: 'plot', content: '# 实际时间线（派生只读）\n\n尚无已发生事件。\n' },
  ];
  return definitions.map((definition) => initializeArtifactContent(db, projectId, {
    path: definition.path,
    kind: definition.kind,
    content: definition.content,
    ownerAgentId: owner(definition.ownerRole),
  }));
}

function defaultCharter(name: string): string {
  return [
    `# ${name} 公司章程`,
    '',
    '## 目标',
    '协同创作长篇小说，按阶段滚动规划，保障人物、情节、时间线长期一致。',
    '',
    '## 协作规则',
    '- 所有实际工作归属于项目，通过 Task 派发。',
    '- 主写手完成章节时必须提交章节变更摘要。',
    '- 派生视图（人物关系、时间线、剧情进度）只读，调整必须通过第一负责人派发关联修正 Task。',
    '- 监察员只能建议，不能自行扩容或改项目方向。',
    '',
    '## 复盘',
    '- 按时间、完成 Task 数或里程碑触发强制复盘。',
    '- 复盘按根员工汇总，不逐条列 Task。',
    '',
  ].join('\n');
}
