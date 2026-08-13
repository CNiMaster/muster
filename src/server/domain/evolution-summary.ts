/**
 * E5 补齐（晨醒模型）：组织进化积压总览。
 *
 * 用户不常开程序时，打开即"晨醒"——进化页头部汇总条回答"攒了哪些升级资料"：
 * 待审批建议 / 待晋升候选 / 已固化 / 待反思。全部是轻量 COUNT 查询。
 */
import type { DB } from '../db/client';
import { getCompanyCockpit } from './company-cockpit';

export interface EvolutionSummary {
  /** 待审批的组织优化建议（report_action_item pending）。 */
  pendingActions: number;
  /** 待晋升候选（promotion_candidate pending）。 */
  pendingPromotions: number;
  /** 已固化建议数（promotion_candidate promoted）。 */
  promotedActions: number;
  /** 待反思任务数（task_reflection pending）。 */
  pendingReflections: number;
}

export function getEvolutionSummary(db: DB, companyId: string): EvolutionSummary {
  // 复用 cockpit 校验公司存在（不存在的公司抛错 → 404 语义）
  const cockpit = getCompanyCockpit(db, companyId);
  const pendingPromotions = (
    db.prepare(`SELECT COUNT(*) AS c FROM promotion_candidate WHERE company_id=? AND status='pending'`).get(companyId) as { c: number }
  ).c;
  const promotedActions = (
    db.prepare(`SELECT COUNT(*) AS c FROM promotion_candidate WHERE company_id=? AND status='promoted'`).get(companyId) as { c: number }
  ).c;
  const pendingReflections = (
    db.prepare(`SELECT COUNT(*) AS c FROM task_reflection WHERE company_id=? AND status='pending'`).get(companyId) as { c: number }
  ).c;
  return {
    pendingActions: cockpit.optimization.pendingActions,
    pendingPromotions,
    promotedActions,
    pendingReflections,
  };
}
