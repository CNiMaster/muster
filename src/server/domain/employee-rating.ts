/**
 * 员工评级（五颗星）领域层。
 *
 * Agent Home 存经验，经验越多星级越高。多维度自动计算 + 用户可手动调整。
 *
 * 维度（初版均分权重，可在 WEIGHT 常量调整）：
 *   - 任务完成数（task WHERE assignee 是该 profile 的任职 AND state=completed）
 *   - 记忆条数（memory_entry WHERE profile_id）
 *   - 任职累计天数（company_employee 跨所有任职）
 *   - 外包验收通过数（outsourcing_contract WHERE vendor_liaison AND state=completed）
 *
 * 详见 docs/superpowers/specs/2026-08-10-temp-worker-and-handover-design.md 第五节。
 */
import type { DB } from '../db/client';
import { nowIso } from '../../shared/utils';

/** 星级阈值（score 加权后映射到 1-5 星）。 */
const STAR_THRESHOLDS = [0, 3, 8, 15, 25]; // 0→1星, 3→2星, 8→3星, 15→4星, 25→5星

export interface RatingBreakdown {
  completedTasks: number;
  memoryEntries: number;
  employmentDays: number;
  deliveredContracts: number;
  score: number;
  stars: number;
}

/** 计算某 profile 的评级明细（不写库）。 */
export function calculateRating(db: DB, profileId: string): RatingBreakdown {
  // 任务完成数：该 profile 的所有任职（agent_definition）作为 assignee 且 completed
  const taskRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM task t
       JOIN agent_definition a ON a.id = t.assignee_agent_id
       WHERE a.profile_id = ? AND t.state = 'completed'`,
    )
    .get(profileId) as { c: number };

  // 记忆条数
  const memRow = db
    .prepare('SELECT COUNT(*) AS c FROM memory_entry WHERE profile_id = ?')
    .get(profileId) as { c: number };

  // 任职累计天数（跨所有公司任职）
  const daysRow = db
    .prepare(
      `SELECT COALESCE(SUM(CAST((julianday(COALESCE(NULLIF(ce.updated_at,''), datetime('now'))) - julianday(ce.created_at)) AS INTEGER)), 0) AS d
       FROM company_employee ce WHERE ce.profile_id = ?`,
    )
    .get(profileId) as { d: number };

  // 外包验收通过数（该 profile 作为乙方对接人，契约 completed）
  const contractRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM outsourcing_contract oc
       JOIN agent_definition a ON a.id = oc.vendor_liaison_agent_id
       WHERE a.profile_id = ? AND oc.state = 'completed'`,
    )
    .get(profileId) as { c: number };

  const completedTasks = taskRow.c ?? 0;
  const memoryEntries = memRow.c ?? 0;
  const employmentDays = daysRow.d ?? 0;
  const deliveredContracts = contractRow.c ?? 0;

  // 加权 score（初版均分，每维度按量级归一化）
  const score =
    completedTasks * 1 +
    memoryEntries * 0.5 +
    employmentDays * 0.2 +
    deliveredContracts * 3;

  const stars = scoreToStars(score);
  return { completedTasks, memoryEntries, employmentDays, deliveredContracts, score, stars };
}

function scoreToStars(score: number): number {
  for (let i = STAR_THRESHOLDS.length - 1; i >= 0; i--) {
    if (score >= STAR_THRESHOLDS[i]) return Math.min(5, i + 1);
  }
  return 1;
}

/** 计算并写回 rating。返回新星级。 */
export function applyRating(db: DB, profileId: string): number {
  const { stars } = calculateRating(db, profileId);
  db.prepare('UPDATE agent_profile SET rating=?, updated_at=? WHERE id=?').run(stars, nowIso(), profileId);
  return stars;
}

/** 用户手动调整星级（体现认可度，覆盖自动计算）。 */
export function adjustRating(db: DB, profileId: string, stars: number): void {
  if (stars < 1 || stars > 5) {
    throw new Error('星级必须在 1-5 之间');
  }
  db.prepare('UPDATE agent_profile SET rating=?, updated_at=? WHERE id=?').run(stars, nowIso(), profileId);
}

/** 批量重算所有 profile 评级（维护任务，如阈值调整后）。返回重算数量。 */
export function recalculateAllRatings(db: DB): number {
  const profiles = db.prepare('SELECT id FROM agent_profile').all() as { id: string }[];
  let count = 0;
  for (const p of profiles) {
    applyRating(db, p.id);
    count++;
  }
  return count;
}
