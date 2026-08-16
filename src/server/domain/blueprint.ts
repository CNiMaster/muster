/**
 * 蓝图组织重构 批次3 + 打法包升格一期：blueprint——从使用中学出来的打法包。
 *
 * 组织 = f(活)：蓝图记录「什么类型的活 → 配什么人设班底 → 用什么工具 → 战绩如何」。
 * - 读取侧：任务创建时未显式指定人设/能力 → matchBlueprint 按标题词元 Jaccard 匹配，
 *   自动穿戴主槽人设（createTask 钩子），2-4 槽班底以协作提示注入上下文。
 * - 写入侧：任务终态进反思队列，drain 消化后 evolveBlueprint 记账（胜/负/返工/纠正/工具）、
 *   聚类合并——自动复盘进化，用户零手动固化。
 * - 版本化：结构性变更（新建/班底变化/工具集变化/状态切换/回滚）写 blueprint_version 提交
 *   （中文摘要 + 证据），每张蓝图最多保留 30 版，可回滚；纯战绩计数不出版。
 * - 治理：蓝图库可见/可锁（locked 冻结进化仍可匹配）/可淘汰（retired 不再匹配）。
 *
 * task_type 是确定性词元集合键（不依赖 LLM）：标题词元排序去重后拼接。
 * 聚类不要求键完全相等：进化按 Jaccard 相似度合并（>= 0.4 并入既有蓝图），
 * 匹配按相似度检索（>= 0.2），与记忆检索的词元策略同源。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { expandMatchTokens } from './memory';

export type BlueprintStatus = 'active' | 'locked' | 'retired';

export interface BlueprintStaffingSlot {
  personaId: string;
  personaName: string;
}

/** 打法工具记账：本蓝图高频使用的工具/skill/MCP（上限 10 条）。 */
export interface BlueprintTool {
  kind: 'skill' | 'tool' | 'mcp';
  id: string;
  uses: number;
  wins: number;
}

export interface Blueprint {
  id: string;
  companyId: string;
  taskType: string;
  label: string;
  /** 用户语言描述：这类活是什么、当前打法（批次3 面板展示，批次4 优化器润色）。 */
  description: string;
  staffing: BlueprintStaffingSlot[];
  tools: BlueprintTool[];
  sourceProjectIds: string[];
  wins: number;
  losses: number;
  reworkTotal: number;
  correctionTotal: number;
  /** 二期预留：阶段工作流（组合管线）。本期恒为空数组。 */
  stages: unknown[];
  status: BlueprintStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BlueprintVersion {
  id: string;
  blueprintId: string;
  version: number;
  snapshot: Record<string, unknown>;
  summary: string;
  evidence: string[];
  createdAt: string;
}

interface BlueprintRow {
  id: string; company_id: string; task_type: string; label: string; description: string;
  staffing_json: string; tools_json: string; source_project_ids_json: string;
  wins: number; losses: number; rework_total: number; correction_total: number;
  stages_json: string | null; status: BlueprintStatus; created_at: string; updated_at: string;
}

interface VersionRow {
  id: string; blueprint_id: string; version: number; snapshot_json: string;
  summary: string; evidence_json: string; created_at: string;
}

function fromRow(row: BlueprintRow): Blueprint {
  return {
    id: row.id,
    companyId: row.company_id,
    taskType: row.task_type,
    label: row.label,
    description: row.description ?? '',
    staffing: JSON.parse(row.staffing_json ?? '[]') as BlueprintStaffingSlot[],
    tools: JSON.parse(row.tools_json ?? '[]') as BlueprintTool[],
    sourceProjectIds: JSON.parse(row.source_project_ids_json ?? '[]') as string[],
    wins: row.wins,
    losses: row.losses,
    reworkTotal: row.rework_total ?? 0,
    correctionTotal: row.correction_total ?? 0,
    stages: row.stages_json ? JSON.parse(row.stages_json) as unknown[] : [],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 词元过滤：去单字/纯数字，保留有区分度的词（长度 >= 2）。 */
function meaningfulTokens(title: string): string[] {
  return [...new Set(
    expandMatchTokens(title).filter((token) => token.length >= 2 && !/^\d+$/.test(token)),
  )].sort();
}

/**
 * 任务类型键：标题词元集合的确定性表示（排序去重拼接）。
 * 词序无关、可重复（同一任务永远同一键）；跨任务的相似匹配靠 jaccard，不要求键完全相等。
 */
export function taskTypeOf(title: string): string {
  return meaningfulTokens(title).join('|');
}

/** 词元集合 Jaccard 相似度（匹配与聚类的统一度量）。 */
export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const token of setA) if (setB.has(token)) inter++;
  return inter / (setA.size + setB.size - inter);
}

/** 匹配阈值：标题词元与蓝图类型词元的 Jaccard 下限（低于此视为不同类型的活）。 */
export const BLUEPRINT_MATCH_THRESHOLD = 0.2;

/** 聚类合并阈值：进化时与既有蓝图的 Jaccard 上限——超过则并入既有蓝图，否则新建。 */
export const BLUEPRINT_MERGE_THRESHOLD = 0.4;

export interface BlueprintMatch {
  blueprint: Blueprint;
  score: number;
}

/**
 * 蓝图匹配：在现役（active/locked）蓝图中找与任务标题最相似的，
 * 按 相似度 > 战绩 排序。retired 不参与。无命中返回 null。
 */
export function matchBlueprint(db: DB, companyId: string, taskTitle: string): BlueprintMatch | null {
  return matchBlueprints(db, companyId, taskTitle, 1)[0] ?? null;
}

/**
 * 打法包一期：返回 top-N 相关蓝图（去同簇：蓝图间 Jaccard >= 并合阈值只取最高分者），
 * 供"相关打法"展示与组合管线的二期铺垫。
 */
export function matchBlueprints(db: DB, companyId: string, taskTitle: string, limit = 3): BlueprintMatch[] {
  const rows = db.prepare(
    "SELECT * FROM blueprint WHERE company_id=? AND status IN ('active','locked')",
  ).all(companyId) as BlueprintRow[];
  const titleTokens = meaningfulTokens(taskTitle);
  const scored: BlueprintMatch[] = [];
  for (const row of rows) {
    const blueprint = fromRow(row);
    const score = jaccard(titleTokens, blueprint.taskType.split('|').filter(Boolean));
    if (score < BLUEPRINT_MATCH_THRESHOLD) continue;
    scored.push({ blueprint, score });
  }
  scored.sort((a, b) => b.score - a.score || b.blueprint.wins - a.blueprint.wins);
  // 去同簇：保留相似度最高的那张，其"近亲"不再重复返回
  const picked: BlueprintMatch[] = [];
  for (const candidate of scored) {
    const nearDuplicate = picked.some((p) =>
      jaccard(candidate.blueprint.taskType.split('|').filter(Boolean), p.blueprint.taskType.split('|').filter(Boolean)) >= BLUEPRINT_MERGE_THRESHOLD);
    if (!nearDuplicate) picked.push(candidate);
    if (picked.length >= limit) break;
  }
  return picked;
}

const MAX_STAFFING_SLOTS = 4;
const MAX_SOURCE_PROJECTS = 8;
const MAX_TOOLS = 10;
const MAX_VERSIONS = 30;

/** 蓝图快照（版本化用：结构字段全集，战绩除外——回滚恢复的是打法不是观察）。 */
function snapshotOf(blueprint: Blueprint): Record<string, unknown> {
  return {
    label: blueprint.label,
    description: blueprint.description,
    staffing: blueprint.staffing,
    tools: blueprint.tools,
    status: blueprint.status,
  };
}

/** 写一版提交：结构变更才调用；超过 MAX_VERSIONS 丢弃最旧。 */
export function commitBlueprintVersion(
  db: DB,
  blueprintId: string,
  summary: string,
  evidence: string[] = [],
): BlueprintVersion {
  const blueprint = getBlueprint(db, blueprintId);
  const maxRow = db.prepare('SELECT MAX(version) AS v FROM blueprint_version WHERE blueprint_id=?').get(blueprintId) as { v: number | null };
  const version = (maxRow.v ?? 0) + 1;
  const id = shortId('bv_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO blueprint_version (id, blueprint_id, version, snapshot_json, summary, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, blueprintId, version, JSON.stringify(snapshotOf(blueprint)), summary, JSON.stringify(evidence), now);
  db.prepare(
    `DELETE FROM blueprint_version WHERE blueprint_id=? AND version < (
       SELECT COALESCE(MAX(version), 0) - ? FROM blueprint_version WHERE blueprint_id=?
     )`,
  ).run(blueprintId, MAX_VERSIONS - 1, blueprintId);
  return listBlueprintVersions(db, blueprintId).find((v) => v.version === version)!;
}

export function listBlueprintVersions(db: DB, blueprintId: string): BlueprintVersion[] {
  const rows = db.prepare(
    'SELECT * FROM blueprint_version WHERE blueprint_id=? ORDER BY version DESC',
  ).all(blueprintId) as VersionRow[];
  return rows.map((row) => ({
    id: row.id,
    blueprintId: row.blueprint_id,
    version: row.version,
    snapshot: JSON.parse(row.snapshot_json) as Record<string, unknown>,
    summary: row.summary,
    evidence: JSON.parse(row.evidence_json ?? '[]') as string[],
    createdAt: row.created_at,
  }));
}

/** 回滚到某版本：恢复结构字段（label/描述/班底/工具/状态），战绩保留，另记一版提交。 */
export function rollbackBlueprint(db: DB, blueprintId: string, targetVersion: number): Blueprint {
  const versions = listBlueprintVersions(db, blueprintId);
  const target = versions.find((v) => v.version === targetVersion);
  if (!target) throw new AppError(ErrorCode.NOT_FOUND, `蓝图版本 v${targetVersion} 不存在`);
  const snapshot = target.snapshot as { label?: string; description?: string; staffing?: BlueprintStaffingSlot[]; tools?: BlueprintTool[]; status?: BlueprintStatus };
  const now = nowIso();
  db.prepare(
    `UPDATE blueprint SET label=?, description=?, staffing_json=?, tools_json=?, status=?, updated_at=? WHERE id=?`,
  ).run(
    snapshot.label ?? '', snapshot.description ?? '',
    JSON.stringify(snapshot.staffing ?? []), JSON.stringify(snapshot.tools ?? []),
    snapshot.status ?? 'active', now, blueprintId,
  );
  const restored = getBlueprint(db, blueprintId);
  commitBlueprintVersion(db, blueprintId, `回滚到 v${targetVersion}：恢复该版本的结构配置（班底/工具/描述/状态）`, [`rollback-from:v${targetVersion}`]);
  return restored;
}

/**
 * 蓝图进化（自动复盘的写入侧）：按任务标题与既有蓝图的词元相似度聚类。
 * - 命中既有蓝图（Jaccard >= BLUEPRINT_MERGE_THRESHOLD，含 locked——战绩是观察不受冻结影响）：
 *   战绩 +1；人设未在班底则并入（上限 4 槽）；来源项目记账（上限 8）。
 * - 未命中：新建（task_type = 标题词元键，label = 人设名·代表任务标题）。
 * - 多维战绩：返工轮次 / 用户纠正次数 / 本任务工具调用并入记账。
 * - 结构性变更（新建/班底变化/工具集变化/复活）自动写版本提交；纯计数不出版。
 * - Review 修复：候选扫描包含 retired——同类活的新证据会让退役蓝图复活（status 回 active），
 *   避免 UNIQUE(company_id, task_type) 冲突被吞导致战绩静默丢失。
 * 幂等性由调用方保证（反思队列 task_id UNIQUE → 每任务只进化一次）。
 */
export function evolveBlueprint(db: DB, input: {
  companyId: string;
  projectId: string;
  taskTitle: string;
  personaId: string;
  personaName: string;
  win: boolean;
  /** 本任务返工轮次（验收链路 rework_count）。 */
  reworkCount?: number;
  /** 本任务派发后的用户追加指令数（纠正信号）。 */
  correctionCount?: number;
  /** 本任务执行过程中实际调用的工具名（execution_trace tool_call）。 */
  tools?: string[];
}): Blueprint {
  const taskType = taskTypeOf(input.taskTitle);
  const titleTokens = meaningfulTokens(input.taskTitle);
  const now = nowIso();
  const candidates = db.prepare(
    'SELECT * FROM blueprint WHERE company_id=?',
  ).all(input.companyId) as BlueprintRow[];
  let existing: BlueprintRow | undefined;
  let bestScore = 0;
  for (const row of candidates) {
    const score = jaccard(titleTokens, fromRow(row).taskType.split('|').filter(Boolean));
    if (score >= BLUEPRINT_MERGE_THRESHOLD && score > bestScore) {
      existing = row;
      bestScore = score;
    }
  }

  if (!existing) {
    const id = shortId('bp_');
    const label = `${input.personaName}·${input.taskTitle.slice(0, 20)}`;
    const description = `用于「${input.taskTitle.slice(0, 24)}」这类工作：主用人设「${input.personaName}」，打法随使用持续进化。`;
    const tools = mergeTools([], input.tools ?? [], input.win);
    db.prepare(
      `INSERT INTO blueprint (id, company_id, task_type, label, description, staffing_json, tools_json,
        source_project_ids_json, wins, losses, rework_total, correction_total, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id, input.companyId, taskType, label, description,
      JSON.stringify([{ personaId: input.personaId, personaName: input.personaName }]),
      JSON.stringify(tools),
      JSON.stringify([input.projectId]),
      input.win ? 1 : 0, input.win ? 0 : 1,
      input.reworkCount ?? 0, input.correctionCount ?? 0,
      now, now,
    );
    const created = getBlueprint(db, id);
    commitBlueprintVersion(db, id, `创建蓝图：用于「${input.taskTitle.slice(0, 20)}」类工作，主用人设「${input.personaName}」`, [input.projectId]);
    return created;
  }

  const blueprint = fromRow(existing);
  const staffing = [...blueprint.staffing];
  let staffingChanged = false;
  if (!staffing.some((slot) => slot.personaId === input.personaId) && staffing.length < MAX_STAFFING_SLOTS) {
    staffing.push({ personaId: input.personaId, personaName: input.personaName });
    staffingChanged = true;
  }
  const sources = [...blueprint.sourceProjectIds];
  if (!sources.includes(input.projectId) && sources.length < MAX_SOURCE_PROJECTS) {
    sources.push(input.projectId);
  }
  const tools = mergeTools(blueprint.tools, input.tools ?? [], input.win);
  const toolsChanged = tools.length !== blueprint.tools.length;
  const revived = blueprint.status === 'retired';
  db.prepare(
    `UPDATE blueprint SET staffing_json=?, tools_json=?, source_project_ids_json=?, description=?,
       wins=?, losses=?, rework_total=?, correction_total=?, status=?, updated_at=? WHERE id=?`,
  ).run(
    JSON.stringify(staffing), JSON.stringify(tools), JSON.stringify(sources), blueprint.description,
    blueprint.wins + (input.win ? 1 : 0),
    blueprint.losses + (input.win ? 0 : 1),
    blueprint.reworkTotal + (input.reworkCount ?? 0),
    blueprint.correctionTotal + (input.correctionCount ?? 0),
    revived ? 'active' : blueprint.status,
    now, existing.id,
  );
  const updated = getBlueprint(db, existing.id);
  if (revived) {
    commitBlueprintVersion(db, existing.id, '复活：同类任务的新证据出现，蓝图恢复现役并继续积累战绩', [input.projectId]);
  } else if (staffingChanged) {
    commitBlueprintVersion(db, existing.id, `班底扩充：新增协作成员「${input.personaName}」（第 ${staffing.length} 槽）`, [input.projectId]);
  } else if (toolsChanged) {
    commitBlueprintVersion(db, existing.id, `工具集扩充：新增 ${tools[tools.length - 1]!.kind}「${tools[tools.length - 1]!.id}」`, [input.projectId]);
  }
  return updated;
}

/** 合并本任务工具调用进打法工具记账（上限 10 条，超出淘汰最少用）。 */
function mergeTools(current: BlueprintTool[], used: string[], win: boolean): BlueprintTool[] {
  if (used.length === 0) return current;
  const map = new Map(current.map((t) => [`${t.kind}:${t.id}`, t]));
  for (const id of used) {
    const key = `tool:${id}`;
    const entry = map.get(key);
    if (entry) {
      entry.uses += 1;
      if (win) entry.wins += 1;
    } else {
      map.set(key, { kind: 'tool', id, uses: 1, wins: win ? 1 : 0 });
    }
  }
  const merged = [...map.values()].sort((a, b) => b.uses - a.uses).slice(0, MAX_TOOLS);
  return merged;
}

export function getBlueprint(db: DB, id: string): Blueprint {
  const row = db.prepare('SELECT * FROM blueprint WHERE id=?').get(id) as BlueprintRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `blueprint ${id} not found`);
  return fromRow(row);
}

export function listBlueprints(db: DB, companyId: string): Blueprint[] {
  const rows = db.prepare(
    'SELECT * FROM blueprint WHERE company_id=? ORDER BY (wins + losses) DESC, updated_at DESC',
  ).all(companyId) as BlueprintRow[];
  return rows.map(fromRow);
}

/** 蓝图状态治理：active（现役）/ locked（锁：仍可匹配，不参与自动淘汰语义）/ retired（淘汰：不再匹配）。状态切换记版本提交。 */
export function setBlueprintStatus(db: DB, id: string, status: BlueprintStatus): Blueprint {
  const current = getBlueprint(db, id);
  if (current.status === status) return current;
  db.prepare('UPDATE blueprint SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), id);
  const summary = status === 'locked'
    ? '锁定：冻结自动进化（仍参与匹配），用户手动治理'
    : status === 'retired'
      ? '淘汰：不再参与匹配，等待同类新证据或用户激活'
      : '激活：恢复现役匹配';
  commitBlueprintVersion(db, id, summary, [`status:${current.status}->${status}`]);
  return getBlueprint(db, id);
}

/** 当前版本号（无版本 = 0）。任务穿戴时写入审计元数据。 */
export function currentBlueprintVersion(db: DB, blueprintId: string): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM blueprint_version WHERE blueprint_id=?').get(blueprintId) as { v: number | null };
  return row.v ?? 0;
}

/** 用户语言描述刷新（批次3 面板/批次4 优化器用）。 */
export function updateBlueprintDescription(db: DB, id: string, description: string): Blueprint {
  const current = getBlueprint(db, id);
  const trimmed = description.trim();
  if (!trimmed || trimmed === current.description) return current;
  db.prepare('UPDATE blueprint SET description=?, updated_at=? WHERE id=?').run(trimmed, nowIso(), id);
  commitBlueprintVersion(db, id, '描述更新：以更清晰的语言说明这类活与当前打法', ['description']);
  return getBlueprint(db, id);
}
