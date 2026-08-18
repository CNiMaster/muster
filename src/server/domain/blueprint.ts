/**
 * 蓝图组织重构 批次3 + 打法包升格一期：blueprint——从使用中学出来的打法包。
 *
 * 组织 = f(活)：蓝图记录「什么类型的活 → 配什么人设班底 → 用什么工具 → 战绩如何」。
 * - 读取侧：任务创建时未显式指定人设/能力 → matchBlueprint 按标题词元 Jaccard 匹配，
 *   自动穿戴主槽人设（createTask 钩子），2-4 槽班底以协作提示注入上下文。
 * - 写入侧：任务终态进反思队列，drain 消化后 evolveBlueprint 记账（胜/负/返工/纠正/工具）、
 *   聚类合并——自动复盘进化，用户零手动固化。
 * - 正向吸收与负向隔离：自有人才上岗表现优异时，提取亮点升级官方默认人设；表现不佳时严格隔离不改差官方配置。
 * - 版本化：结构性变更（新建/班底变化/工具集变化/状态切换/回滚/正向吸收）写 blueprint_version 提交。
 * - 治理：蓝图库可见/可锁/可淘汰/AI 咨询/单开独立调试任务。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { expandMatchTokens } from './memory';
import { findUserTalentForPersona, type AgentProfile } from './agent-profile';

export type BlueprintStatus = 'active' | 'locked' | 'retired';

export interface BlueprintStaffingSlot {
  personaId: string;
  personaName: string;
}

export interface BlueprintStaffingDetailSlot extends BlueprintStaffingSlot {
  activeUserTalent: AgentProfile | null;
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
  /** 用户语言描述：这类活是什么、当前打法。 */
  description: string;
  staffing: BlueprintStaffingSlot[];
  tools: BlueprintTool[];
  sourceProjectIds: string[];
  wins: number;
  losses: number;
  reworkTotal: number;
  correctionTotal: number;
  /** 阶段工作流（组合管线）。 */
  stages: unknown[];
  status: BlueprintStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BlueprintDetail extends Blueprint {
  staffingWithActiveTalents: BlueprintStaffingDetailSlot[];
  versions: BlueprintVersion[];
  score: {
    score: number | null;
    winRate: number;
    reworkRate: number;
    correctionRate: number;
  };
}

import { getWorkbenchOrNull } from './workbench';

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
  id: string; task_type: string; label: string; description: string;
  staffing_json: string; tools_json: string; source_project_ids_json: string;
  wins: number; losses: number; rework_total: number; correction_total: number;
  stages_json: string | null; status: BlueprintStatus; created_at: string; updated_at: string;
}

interface VersionRow {
  id: string; blueprint_id: string; version: number; snapshot_json: string;
  summary: string; evidence_json: string; created_at: string;
}

function fromRow(db: DB, row: BlueprintRow): Blueprint {
  return {
    id: row.id,
    companyId: getWorkbenchOrNull(db)?.id ?? '',
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

function versionFromRow(row: VersionRow): BlueprintVersion {
  return {
    id: row.id,
    blueprintId: row.blueprint_id,
    version: row.version,
    snapshot: JSON.parse(row.snapshot_json ?? '{}'),
    summary: row.summary,
    evidence: JSON.parse(row.evidence_json ?? '[]'),
    createdAt: row.created_at,
  };
}

export function getBlueprint(db: DB, id: string): Blueprint {
  const row = db.prepare('SELECT * FROM blueprint WHERE id = ?').get(id) as BlueprintRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `blueprint ${id} not found`);
  return fromRow(db, row);
}

export const MAX_STAFFING_SLOTS = 4;
export const MAX_TOOLS = 10;
export const MAX_SOURCE_PROJECTS = 8;
export const MAX_VERSIONS = 30;

function meaningfulTokens(title: string): string[] {
  return [...new Set(
    expandMatchTokens(title).filter((token) => token.length >= 2 && !/^\d+$/.test(token)),
  )].sort();
}

export function taskTypeOf(title: string): string {
  return meaningfulTokens(title).join('|');
}

export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const token of setA) if (setB.has(token)) inter++;
  return inter / (setA.size + setB.size - inter);
}

export const BLUEPRINT_MATCH_THRESHOLD = 0.2;
export const BLUEPRINT_MERGE_THRESHOLD = 0.4;

export interface BlueprintMatch {
  blueprint: Blueprint;
  score: number;
}

export function matchBlueprint(db: DB, companyId: string, taskTitle: string): BlueprintMatch | null {
  return matchBlueprints(db, companyId, taskTitle, 1)[0] ?? null;
}

export function matchBlueprints(db: DB, companyId?: string, taskTitle = '', limit = 3): BlueprintMatch[] {
  const rows = db.prepare(
    "SELECT * FROM blueprint WHERE status != 'retired'",
  ).all() as BlueprintRow[];
  if (rows.length === 0) return [];
  const titleTokens = meaningfulTokens(taskTitle);
  if (titleTokens.length === 0) return [];

  const scored: Array<{ row: BlueprintRow; score: number; bpTokens: string[] }> = [];
  for (const row of rows) {
    const bpTokens = fromRow(db, row).taskType.split('|').filter(Boolean);
    const score = jaccard(titleTokens, bpTokens);
    if (score >= BLUEPRINT_MATCH_THRESHOLD) {
      scored.push({ row, score, bpTokens });
    }
  }

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.05) return b.score - a.score;
    const totalA = a.row.wins + a.row.losses;
    const totalB = b.row.wins + b.row.losses;
    const rateA = totalA > 0 ? a.row.wins / totalA : 0;
    const rateB = totalB > 0 ? b.row.wins / totalB : 0;
    return rateB - rateA;
  });

  const picked: BlueprintMatch[] = [];
  for (const item of scored) {
    const isDuplicateCluster = picked.some((p) => {
      const pTokens = p.blueprint.taskType.split('|').filter(Boolean);
      return jaccard(item.bpTokens, pTokens) >= BLUEPRINT_MERGE_THRESHOLD;
    });
    if (!isDuplicateCluster) {
      picked.push({ blueprint: fromRow(db, item.row), score: item.score });
      if (picked.length >= limit) break;
    }
  }
  return picked;
}

export function commitBlueprintVersion(
  db: DB,
  blueprintId: string,
  summary: string,
  evidence: string[] = [],
): BlueprintVersion {
  const bp = getBlueprint(db, blueprintId);
  const now = nowIso();
  const last = db.prepare('SELECT MAX(version) AS v FROM blueprint_version WHERE blueprint_id=?').get(blueprintId) as { v: number | null };
  const nextVersion = (last.v ?? 0) + 1;
  const id = shortId('bpv_');
  const snapshot = {
    taskType: bp.taskType,
    label: bp.label,
    description: bp.description,
    staffing: bp.staffing,
    tools: bp.tools,
    stages: bp.stages,
    status: bp.status,
  };
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO blueprint_version (id, blueprint_id, version, snapshot_json, summary, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, blueprintId, nextVersion, JSON.stringify(snapshot), summary, JSON.stringify(evidence), now);

    const count = (db.prepare('SELECT COUNT(*) AS c FROM blueprint_version WHERE blueprint_id=?').get(blueprintId) as { c: number }).c;
    if (count > MAX_VERSIONS) {
      const oldest = db.prepare(
        'SELECT id FROM blueprint_version WHERE blueprint_id=? ORDER BY version ASC LIMIT ?',
      ).all(blueprintId, count - MAX_VERSIONS) as Array<{ id: string }>;
      for (const row of oldest) {
        db.prepare('DELETE FROM blueprint_version WHERE id=?').run(row.id);
      }
    }
    return versionFromRow(
      db.prepare('SELECT * FROM blueprint_version WHERE id=?').get(id) as VersionRow,
    );
  })();
}

export function listBlueprintVersions(db: DB, blueprintId: string): BlueprintVersion[] {
  const rows = db.prepare(
    'SELECT * FROM blueprint_version WHERE blueprint_id=? ORDER BY version DESC',
  ).all(blueprintId) as VersionRow[];
  return rows.map(versionFromRow);
}

export function rollbackBlueprint(db: DB, blueprintId: string, targetVersion: number): Blueprint {
  const row = db.prepare(
    'SELECT * FROM blueprint_version WHERE blueprint_id=? AND version=?',
  ).get(blueprintId, targetVersion) as VersionRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `blueprint ${blueprintId} version ${targetVersion} not found`);
  const target = versionFromRow(row);
  const snap = target.snapshot as {
    taskType: string; label: string; description?: string; staffing: BlueprintStaffingSlot[];
    tools: BlueprintTool[]; stages?: unknown[]; status: BlueprintStatus;
  };
  const now = nowIso();
  return db.transaction(() => {
    db.prepare(
      `UPDATE blueprint SET staffing_json=?, tools_json=?, stages_json=?, description=?, status=?, updated_at=? WHERE id=?`,
    ).run(
      JSON.stringify(snap.staffing ?? []),
      JSON.stringify(snap.tools ?? []),
      JSON.stringify(snap.stages ?? []),
      snap.description ?? '',
      snap.status ?? 'active',
      now, blueprintId,
    );
    commitBlueprintVersion(db, blueprintId, `回滚到 v${targetVersion}：恢复该版结构配置（战绩保留另记）`, [`rollback_to:v${targetVersion}`]);
    return getBlueprint(db, blueprintId);
  })();
}

/**
 * 蓝图进化：支持正向吸收升级与负向隔离保护。
 */
export function evolveBlueprint(db: DB, input: {
  companyId: string;
  projectId: string;
  taskTitle: string;
  personaId: string;
  personaName: string;
  win: boolean;
  reworkCount?: number;
  correctionCount?: number;
  tools?: string[];
  isUserOverride?: boolean;
  userTalentName?: string;
}): Blueprint | null {
  const taskType = taskTypeOf(input.taskTitle);
  const titleTokens = meaningfulTokens(input.taskTitle);
  const now = nowIso();
  const candidates = db.prepare(
    'SELECT * FROM blueprint',
  ).all() as BlueprintRow[];
  let existing: BlueprintRow | undefined;
  let bestScore = 0;
  for (const row of candidates) {
    const score = jaccard(titleTokens, fromRow(db, row).taskType.split('|').filter(Boolean));
    if (score >= BLUEPRINT_MERGE_THRESHOLD && score > bestScore) {
      existing = row;
      bestScore = score;
    }
  }

  // 负向保护：若是自有人才执行且失败/返工，严格不修改或劣化官方默认蓝图
  if (input.isUserOverride && (!input.win || (input.reworkCount ?? 0) > 0)) {
    // 有既有蓝图：原样返回不记战绩；无既有蓝图：直接跳过进化——绝不把负面表现写进官方基准或新蓝图
    return existing ? fromRow(db, existing) : null;
  }

  if (!existing) {
    const id = shortId('bp_');
    const label = `${input.personaName}·${input.taskTitle.slice(0, 20)}`;
    const description = `用于「${input.taskTitle.slice(0, 24)}」这类工作：主用人设「${input.personaName}」，打法随使用持续进化。`;
    const tools = mergeTools([], input.tools ?? [], input.win);
    db.prepare(
      `INSERT INTO blueprint (id, task_type, label, description, staffing_json, tools_json,
        source_project_ids_json, wins, losses, rework_total, correction_total, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id, taskType, label, description,
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

  const blueprint = fromRow(db, existing);
  const structureFrozen = blueprint.status === 'locked';
  const staffing = [...blueprint.staffing];
  let staffingChanged = false;
  if (!structureFrozen && !staffing.some((slot) => slot.personaId === input.personaId) && staffing.length < MAX_STAFFING_SLOTS) {
    staffing.push({ personaId: input.personaId, personaName: input.personaName });
    staffingChanged = true;
  }
  const sources = [...blueprint.sourceProjectIds];
  if (!structureFrozen && !sources.includes(input.projectId) && sources.length < MAX_SOURCE_PROJECTS) {
    sources.push(input.projectId);
  }
  const tools = structureFrozen ? blueprint.tools : mergeTools(blueprint.tools, input.tools ?? [], input.win);
  const toolsChanged = tools.length !== blueprint.tools.length;
  const revived = blueprint.status === 'retired';

  return db.transaction(() => {
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
    if (revived) {
      commitBlueprintVersion(db, existing.id, '复活：同类任务的新证据出现，蓝图恢复现役并继续积累战绩', [input.projectId]);
    } else if (input.isUserOverride && input.win && (input.reworkCount ?? 0) === 0) {
      commitBlueprintVersion(db, existing.id, `正向吸收：吸收自有人才「${input.userTalentName || input.personaName}」的优秀实践升级官方默认打法配置`, [input.projectId]);
    } else if (staffingChanged) {
      commitBlueprintVersion(db, existing.id, `班底扩充：新增协作成员「${input.personaName}」（第 ${staffing.length} 槽）`, [input.projectId]);
    } else if (toolsChanged) {
      const added = tools.filter((t) => !blueprint.tools.some((o) => o.kind === t.kind && o.id === t.id)).map((t) => t.id);
      commitBlueprintVersion(db, existing.id, `工具集扩充：新增 ${added.join('、')}`, [input.projectId]);
    }
    return getBlueprint(db, existing.id);
  })();
}

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
  return [...map.values()].sort((a, b) => b.uses - a.uses).slice(0, MAX_TOOLS);
}

export function getBlueprintDetail(db: DB, id: string): BlueprintDetail {
  const bp = getBlueprint(db, id);
  const versions = listBlueprintVersions(db, id);
  const total = bp.wins + bp.losses;
  const winRate = total > 0 ? bp.wins / total : 0;
  const reworkRate = total > 0 ? Math.min(1, bp.reworkTotal / total) : 0;
  const correctionRate = total > 0 ? Math.min(1, bp.correctionTotal / total) : 0;
  const score = total >= 3 ? Math.round((winRate * 0.6 + (1 - reworkRate) * 0.25 + (1 - correctionRate) * 0.15) * 100) : null;

  const staffingWithActiveTalents = bp.staffing.map((slot) => ({
    ...slot,
    activeUserTalent: findUserTalentForPersona(db, slot.personaId),
  }));

  return {
    ...bp,
    staffingWithActiveTalents,
    versions,
    score: {
      score,
      winRate: Math.round(winRate * 100),
      reworkRate: Math.round(reworkRate * 100),
      correctionRate: Math.round(correctionRate * 100),
    },
  };
}

export function publishBlueprintDebugResult(db: DB, input: {
  blueprintId: string;
  staffing?: BlueprintStaffingSlot[];
  tools?: BlueprintTool[];
  stages?: unknown[];
  description?: string;
  summary: string;
  evidenceTaskId?: string;
}): Blueprint {
  const current = getBlueprint(db, input.blueprintId);
  const now = nowIso();
  const staffing = input.staffing ?? current.staffing;
  const tools = input.tools ?? current.tools;
  const stages = input.stages ?? current.stages;
  const description = input.description ?? current.description;

  return db.transaction(() => {
    db.prepare(
      `UPDATE blueprint SET staffing_json=?, tools_json=?, stages_json=?, description=?, updated_at=? WHERE id=?`,
    ).run(
      JSON.stringify(staffing),
      JSON.stringify(tools),
      JSON.stringify(stages),
      description,
      now,
      input.blueprintId,
    );
    commitBlueprintVersion(
      db,
      input.blueprintId,
      `调试任务采纳：${input.summary}`,
      input.evidenceTaskId ? [input.evidenceTaskId] : ['blueprint_debug'],
    );
    return getBlueprint(db, input.blueprintId);
  })();
}

export function listBlueprints(db: DB, companyId?: string): Blueprint[] {
  const rows = db.prepare(
    'SELECT * FROM blueprint ORDER BY (wins + losses) DESC, updated_at DESC',
  ).all() as BlueprintRow[];
  return rows.map((r) => fromRow(db, r));
}

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

export function currentBlueprintVersion(db: DB, blueprintId: string): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM blueprint_version WHERE blueprint_id=?').get(blueprintId) as { v: number | null };
  return row.v ?? 0;
}

export function updateBlueprintDescription(db: DB, id: string, description: string): Blueprint {
  const current = getBlueprint(db, id);
  const trimmed = description.trim();
  if (!trimmed || trimmed === current.description) return current;
  db.prepare('UPDATE blueprint SET description=?, updated_at=? WHERE id=?').run(trimmed, nowIso(), id);
  commitBlueprintVersion(db, id, '描述更新：以更清晰的语言说明这类活与当前打法', ['description']);
  return getBlueprint(db, id);
}
