/**
 * 长篇小说项目预设：渐进式基础成果（canon 账本 + 打法档案 + 派生视图）+ 维护岗位白名单。
 *
 * 蓝图组织重构批次 E：固定岗位模板已退场——工作台默认员工只有负责人+验收员（ensureWorkspaceStaff），
 * 主写手/人物/情节等专家角色由任务按蓝图自动穿戴人设生成；本文件只保留项目初始化逻辑。
 *
 * 2026-09-06（inkos 理念对账）：题材扩展包退役——通用程序不预置领域答案，
 * 打法档案（planning/genre-rules.md）只给栏位与引导问题，内容由建档阶段与用户共同长出来；
 * 伏笔/大纲/文风模板账本化栏位化，供阶段流水线「建档→写作→审计→结算」消费。
 * 详见 docs/superpowers/specs/2026-09-06-blueprint-domain-profile.md。
 */
import type { DB } from '../db/client';
import { listAgents } from './agent';
import { initializeArtifactContent, readArtifactContent } from './artifact-content';
import { getArtifactByPath, type Artifact, type ArtifactKind } from './artifact';
import { getProject, listProjects } from './project';
import { getWorkbenchOrNull } from './workbench';

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

/** 创建长篇小说项目的渐进式基础成果。幂等，不覆盖已有内容。 */
export function initializeNovelProject(db: DB, projectId: string): Artifact[] {
  const project = getProject(db, projectId);
  const agents = listAgents(db);
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
    { path: 'project/brief.md', kind: 'project_brief', ownerRole: 'lead', content: `# ${project.name}\n\n${project.description || '等待负责人根据初始任务逐步完善。'}\n` },
    { path: 'planning/synopsis.md', kind: 'synopsis', ownerRole: 'lead', content: '# 故事梗概\n\n等待项目规划。\n' },
    { path: 'planning/style-profile.md', kind: 'style_profile', ownerRole: styleOwner, content: '# 文风档案\n\n等待用户与主笔共同确认。\n\n## 叙事人称与视角\n\n（待定）\n\n## 语言基调\n\n（待定）\n\n## 节奏与禁忌衔接\n\n节奏承诺与疲劳词清单以「打法档案」（planning/genre-rules.md）为准，本档案不重复维护。\n' },
    { path: 'planning/genre-rules.md', kind: 'genre_rules', ownerRole: 'plot', content: '# 打法档案\n\n> 这是本书自己的打法，不是任何题材的通用模板：栏位由负责人与创作班底共同确认，没确认的保持「待定」，写作与审计不引用未确认内容。\n> 档案随时可改，下一章生效；与正文冲突时先改档案或先改稿，不许两头各走各的。\n\n## 章节类型\n\n（本书把章节分成哪几类、各类的任务是什么？——待定）\n\n## 节奏承诺\n\n（多少章之内必须给读者一次什么级别的反馈？——待定）\n\n## 反馈与爽点\n\n（读者来这里要什么？本书认可的兑现方式有哪些？——待定）\n\n## 题材禁忌\n\n（这本书绝对不写什么？哪些俗手直接禁？——待定）\n\n## 疲劳词\n\n（哪些词与句式在本书里滥用会倒胃口？列禁用/慎用清单。——待定）\n\n## 读者承诺\n\n（开篇对读者许了什么愿？多久兑现一次、什么时候兑现完？——待定）\n' },
    { path: 'planning/outline.md', kind: 'outline', ownerRole: 'plot', content: '# 计划大纲\n\n按创作进度滚动展开：脊柱（一句话主线+结局锚）不轻易动，卷与章滚动细化。\n\n## 章节清单\n\n| 章 | 类型（取值见打法档案） | 本章目标一句话 | 伏笔操作 | 状态 |\n| --- | --- | --- | --- | --- |\n\n## 卷/段落规划\n\n（待建——只展开最近一两卷，远期留白。）\n' },
    { path: 'canon/characters.md', kind: 'character_sheet', ownerRole: characterOwner, content: '# 人物档案\n\n随章节进展维护。\n' },
    { path: 'canon/worldbuilding.md', kind: 'worldbuilding', ownerRole: worldbuildingOwner, content: '# 世界观\n\n随项目需要逐步建立。\n' },
    { path: 'canon/timeline.md', kind: 'timeline', ownerRole: timelineOwner, content: '# 时间线资料\n\n随章节进展维护。\n' },
    { path: 'canon/foreshadowing.md', kind: 'foreshadowing', ownerRole: foreshadowingOwner, content: '# 伏笔账本\n\n> 用法：埋设时登记一行；每次推进更新「最近推进」并写明推进到哪；回收后状态改「已回收」并在备注标呼应位置。\n> 半衰期约定：过了「预期回收」章节仍无推进的伏笔，审计与结算阶段必须显式提示——续上或明确弃收，不许自然遗忘。\n\n| 编号 | 埋设章 | 类型 | 状态 | 最近推进 | 预期回收 | 依赖 | 备注 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n\n（埋设第一章时登记第一行；「类型」「状态」的取值由本书打法档案定义。）\n' },
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
    '- 派生视图（人物关系、时间线、剧情进度）只读，调整必须通过负责人派发关联修正 Task。',
    '- 监察员只能建议，不能自行扩容或改项目方向。',
    '',
    '## 复盘',
    '- 按时间、完成 Task 数或里程碑触发强制复盘。',
    '- 复盘按根员工汇总，不逐条列 Task。',
    '',
  ].join('\n');
}

// ── 2026-09-06 收尾批次：存量补种 / 打法档案建档状态 / 伏笔半衰期诊断 ──

/** 打法档案路径与六栏位（与 initializeNovelProject 的 genre-rules 模板保持一致）。 */
export const GENRE_RULES_PATH = 'planning/genre-rules.md';
const GENRE_RULES_SLOT_TITLES = ['章节类型', '节奏承诺', '反馈与爽点', '题材禁忌', '疲劳词', '读者承诺'];

/**
 * 启动时为小说工作台的业务项目补种渐进式基础成果（打法档案、canon 账本等）。
 * 幂等：initializeArtifactContent 不覆盖已有内容——只补新批次引入的缺口成果（如存量项目缺 genre-rules）。
 * 跳过：归档项目、收件箱/独立任务等基础设施载体（它们不是创作现场）；单项目失败不阻断其余。
 * 返回成功处理的项目数（0 = 非小说工作台，静默跳过）。
 */
export function ensureNovelProjectArtifacts(db: DB): number {
  const workbench = getWorkbenchOrNull(db);
  if (!workbench || workbench.kind !== 'novel') return 0;
  // listProjects 的 companyId 参数未参与过滤（历史怪癖）——这里显式按工作台过滤
  const projects = listProjects(db).filter((p) => p.companyId === workbench.id);
  let ensured = 0;
  for (const project of projects) {
    if (project.state === 'archived') continue;
    const settings = project.settings as Record<string, unknown>;
    if (settings?.inbox === true || settings?.standalone === true) continue;
    try {
      initializeNovelProject(db, project.id);
      ensured += 1;
    } catch {
      // 单项目 rootDir 缺失/不可写等：跳过，下次启动重试（幂等）
    }
  }
  return ensured;
}

export interface NovelProfileStatus {
  /** 档案成果是否已注册（存量项目可能在 ensure 前缺失）。 */
  exists: boolean;
  totalSlots: number;
  pendingSlots: number;
  /** 仍为「待定」的栏位标题。 */
  pendingTitles: string[];
}

/**
 * 打法档案建档状态：逐栏检查正文是否仍是「待定」占位。
 * 约定与模板一致——用户把「待定」字样改掉即视为该栏已确认；档案随时可改，下一章生效。
 */
export function getNovelProfileStatus(db: DB, projectId: string): NovelProfileStatus {
  if (!getArtifactByPath(db, projectId, GENRE_RULES_PATH)) {
    return { exists: false, totalSlots: GENRE_RULES_SLOT_TITLES.length, pendingSlots: GENRE_RULES_SLOT_TITLES.length, pendingTitles: [...GENRE_RULES_SLOT_TITLES] };
  }
  let content = '';
  try {
    content = readArtifactContent(db, projectId, GENRE_RULES_PATH);
  } catch {
    content = '';
  }
  const sections = parseMarkdownH2Sections(content);
  const pendingTitles = GENRE_RULES_SLOT_TITLES.filter((title) => {
    const body = sections.get(title);
    return body === undefined ? true : body.includes('待定');
  });
  return {
    exists: true,
    totalSlots: GENRE_RULES_SLOT_TITLES.length,
    pendingSlots: pendingTitles.length,
    pendingTitles,
  };
}

/** 把 markdown 按 `## 标题` 切段（标题 → 小节正文，不含标题行本身）。 */
function parseMarkdownH2Sections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  const buffer: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (current !== null) sections.set(current, buffer.join('\n'));
      current = match[1]!;
      buffer.length = 0;
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  if (current !== null) sections.set(current, buffer.join('\n'));
  return sections;
}

export interface StaleHook {
  id: string;
  startChapter: string;
  status: string;
  lastAdvanced: string;
  expectedPayoff: string;
  notes: string;
}

/**
 * 伏笔半衰期诊断（确定性，不靠模型自觉）：解析伏笔账本（canon/foreshadowing.md）的行，
 * 「已回收/弃收」以外、且「预期回收」是数字并已被当前章数越过的行判为超期。
 * 列序与账本模板一致：编号/埋设章/类型/状态/最近推进/预期回收/依赖/备注。
 */
export function detectStaleHooks(db: DB, projectId: string, currentChapter: number): StaleHook[] {
  let content = '';
  try {
    content = readArtifactContent(db, projectId, 'canon/foreshadowing.md');
  } catch {
    return [];
  }
  const stale: StaleHook[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
    if (cells[0] === '编号' || /^:?-{2,}:?$/.test(cells[0] ?? '')) continue;
    const [id, startChapter, , status, lastAdvanced, expectedPayoff, , notes] = cells;
    if (!id || id === '—' || !expectedPayoff) continue;
    const payoffChapter = Number(expectedPayoff);
    if (!Number.isFinite(payoffChapter)) continue;
    if (/(已回收|弃收)/.test(status ?? '')) continue;
    if (currentChapter > payoffChapter) {
      stale.push({
        id,
        startChapter: startChapter ?? '',
        status: status ?? '',
        lastAdvanced: lastAdvanced ?? '',
        expectedPayoff,
        notes: notes ?? '',
      });
    }
  }
  return stale;
}
