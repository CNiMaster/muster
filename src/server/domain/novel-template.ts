/**
 * 长篇小说公司模板：生成员工、关系、协议、流程。
 *
 基础岗位：项目第一负责人、主写手、人物设计、情节架构、运营监察。
 约束：第一负责人与主写手禁止由同一员工兼任。
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

export interface NovelTemplateInput {
  name: string;
  charter?: string;
  /** 默认风格、题材等元信息。 */
  meta?: Record<string, unknown>;
  departments?: Array<{ name: string; purpose?: string }>;
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

  // 设第一负责人（刷新 company 对象）
  const updatedCompany = updateCompany(db, company.id, { firstAgentId: lead.id });

  // 组织关系：lead 管理所有
  for (const a of [writer, character, plot, inspector]) {
    addRelationship(db, { companyId: company.id, kind: 'org', sourceId: lead.id, targetId: a.id, label: '管辖' });
  }
  // 通信关系：lead 可联系所有人；writer 可联系 character + plot（求助资料）
  lead.contactAllow = [writer.id, character.id, plot.id, inspector.id];
  writer.contactAllow = [character.id, plot.id, lead.id];
  character.contactAllow = [lead.id, writer.id];
  plot.contactAllow = [lead.id, writer.id];
  // update agent contact_allow
  for (const a of [lead, writer, character, plot, inspector] as AgentDefinition[]) {
    db.prepare('UPDATE agent_definition SET contact_allow_json=? WHERE id=?').run(JSON.stringify(a.contactAllow), a.id);
  }
  // 通信图边
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: lead.id, targetId: writer.id, label: '派发' });
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: writer.id, targetId: character.id, label: '求人物资料' });
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: writer.id, targetId: plot.id, label: '求情节资料' });
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: inspector.id, targetId: lead.id, label: '告警' });

  return { company: updatedCompany, departments, agents: { lead, writer, character, plot, inspector } };
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
  const definitions: Array<{
    path: string;
    kind: ArtifactKind;
    ownerRole: string;
    content: string;
  }> = [
    { path: 'project/brief.md', kind: 'project_brief', ownerRole: 'lead', content: `# ${project.name}\n\n${project.description || '等待第一负责人根据初始任务逐步完善。'}\n` },
    { path: 'planning/synopsis.md', kind: 'synopsis', ownerRole: 'lead', content: '# 故事梗概\n\n等待项目规划。\n' },
    { path: 'planning/style-profile.md', kind: 'style_profile', ownerRole: 'writer', content: '# 文风档案\n\n等待用户与主写手共同确认。\n' },
    { path: 'planning/outline.md', kind: 'outline', ownerRole: 'plot', content: '# 计划大纲\n\n按创作进度滚动展开。\n' },
    { path: 'canon/characters.md', kind: 'character_sheet', ownerRole: 'character', content: '# 人物档案\n\n随章节进展维护。\n' },
    { path: 'canon/worldbuilding.md', kind: 'worldbuilding', ownerRole: 'plot', content: '# 世界观\n\n随项目需要逐步建立。\n' },
    { path: 'canon/timeline.md', kind: 'timeline', ownerRole: 'plot', content: '# 时间线资料\n\n随章节进展维护。\n' },
    { path: 'canon/foreshadowing.md', kind: 'foreshadowing', ownerRole: 'plot', content: '# 伏笔资料\n\n记录埋设、推进与回收状态。\n' },
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
