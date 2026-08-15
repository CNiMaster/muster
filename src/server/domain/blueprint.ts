/**
 * 蓝图组织重构 批次3：蓝图（blueprint）——从使用中学出来的组织形状。
 *
 * 组织 = f(活)：蓝图记录「什么类型的活 → 配什么人设 → 战绩如何」。
 * - 读取侧：任务创建时未显式指定人设/能力 → matchBlueprint 按标题词元 Jaccard 匹配，
 *   自动穿戴胜率最高的人设（createTask 钩子）。
 * - 写入侧：任务终态进反思队列，drain 消化后 evolveBlueprint 记账（胜/负）、
 *   聚类（同人设同类活合并进同一蓝图）——自动复盘进化，用户零手动固化。
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

export interface Blueprint {
  id: string;
  companyId: string;
  taskType: string;
  label: string;
  staffing: BlueprintStaffingSlot[];
  sourceProjectIds: string[];
  wins: number;
  losses: number;
  status: BlueprintStatus;
  createdAt: string;
  updatedAt: string;
}

interface BlueprintRow {
  id: string; company_id: string; task_type: string; label: string;
  staffing_json: string; source_project_ids_json: string;
  wins: number; losses: number; status: BlueprintStatus; created_at: string; updated_at: string;
}

function fromRow(row: BlueprintRow): Blueprint {
  return {
    id: row.id,
    companyId: row.company_id,
    taskType: row.task_type,
    label: row.label,
    staffing: JSON.parse(row.staffing_json ?? '[]') as BlueprintStaffingSlot[],
    sourceProjectIds: JSON.parse(row.source_project_ids_json ?? '[]') as string[],
    wins: row.wins,
    losses: row.losses,
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
  const rows = db.prepare(
    "SELECT * FROM blueprint WHERE company_id=? AND status IN ('active','locked')",
  ).all(companyId) as BlueprintRow[];
  const titleTokens = meaningfulTokens(taskTitle);
  let best: BlueprintMatch | null = null;
  for (const row of rows) {
    const blueprint = fromRow(row);
    const score = jaccard(titleTokens, blueprint.taskType.split('|').filter(Boolean));
    if (score < BLUEPRINT_MATCH_THRESHOLD) continue;
    const better = !best
      || score > best.score
      || (score === best.score && blueprint.wins > best.blueprint.wins);
    if (better) best = { blueprint, score };
  }
  return best;
}

const MAX_STAFFING_SLOTS = 4;
const MAX_SOURCE_PROJECTS = 8;

/**
 * 蓝图进化（自动复盘的写入侧）：按任务标题与既有蓝图的词元相似度聚类。
 * - 命中既有蓝图（Jaccard >= BLUEPRINT_MERGE_THRESHOLD，含 locked——战绩是观察不受冻结影响）：
 *   战绩 +1；人设未在组内则并入（上限 4 槽）；来源项目记账（上限 8）。
 * - 未命中：新建（task_type = 标题词元键，label = 人设名·代表任务标题）。
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
    db.prepare(
      `INSERT INTO blueprint (id, company_id, task_type, label, staffing_json, source_project_ids_json,
        wins, losses, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id, input.companyId, taskType,
      `${input.personaName}·${input.taskTitle.slice(0, 20)}`,
      JSON.stringify([{ personaId: input.personaId, personaName: input.personaName }]),
      JSON.stringify([input.projectId]),
      input.win ? 1 : 0,
      input.win ? 0 : 1,
      now, now,
    );
    return getBlueprint(db, id);
  }

  const blueprint = fromRow(existing);
  const staffing = [...blueprint.staffing];
  if (!staffing.some((slot) => slot.personaId === input.personaId) && staffing.length < MAX_STAFFING_SLOTS) {
    staffing.push({ personaId: input.personaId, personaName: input.personaName });
  }
  const sources = [...blueprint.sourceProjectIds];
  if (!sources.includes(input.projectId) && sources.length < MAX_SOURCE_PROJECTS) {
    sources.push(input.projectId);
  }
  db.prepare(
    `UPDATE blueprint SET staffing_json=?, source_project_ids_json=?, wins=?, losses=?, status=?, updated_at=? WHERE id=?`,
  ).run(
    JSON.stringify(staffing), JSON.stringify(sources),
    blueprint.wins + (input.win ? 1 : 0),
    blueprint.losses + (input.win ? 0 : 1),
    // Review 修复：同类活的新证据让退役蓝图复活（同键新插会撞 UNIQUE，此处复活避免静默丢战绩）。
    blueprint.status === 'retired' ? 'active' : blueprint.status,
    now, existing.id,
  );
  return getBlueprint(db, existing.id);
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

/** 蓝图状态治理：active（现役）/ locked（锁：仍可匹配，不参与自动淘汰语义）/ retired（淘汰：不再匹配）。 */
export function setBlueprintStatus(db: DB, id: string, status: BlueprintStatus): Blueprint {
  const current = getBlueprint(db, id);
  if (current.status === status) return current;
  db.prepare('UPDATE blueprint SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), id);
  return getBlueprint(db, id);
}
