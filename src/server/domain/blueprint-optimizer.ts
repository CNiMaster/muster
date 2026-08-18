/**
 * 蓝图优化建议的暂存与落地（进化环收拢批次4；2026-08-17 起建议产出改为每蓝图独立优化对话，
 * 见 blueprint-optimize-chat.ts——本模块只保留提案的落库/采纳/忽略基建）。
 *
 * 提案动作：lock（锁定高胜率）/ retire（淘汰长期负）/ merge（合并近重复）/ polish_description（润色描述）。
 * 采纳落地全部走蓝图版本化提交，用户可回滚。动作域只作用于蓝图（组织 = f(活) 的正主）。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { setBlueprintStatus, updateBlueprintDescription, commitBlueprintVersion, getBlueprint, type Blueprint } from './blueprint';

export type BlueprintOptimizationActionType = 'lock' | 'retire' | 'merge' | 'polish_description';

export interface BlueprintOptimizationItem {
  id: string;
  blueprintId: string;
  actionType: BlueprintOptimizationActionType;
  /** merge 的目标蓝图（并入谁）。 */
  targetBlueprintId: string | null;
  reason: string;
  expectedEffect: string;
  params: Record<string, unknown>;
  status: 'pending' | 'applied' | 'ignored';
  createdAt: string;
}

interface ItemRow {
  id: string; blueprint_id: string; action_type: string;
  target_blueprint_id: string | null; reason: string; expected_effect: string;
  params_json: string; status: string; created_at: string;
}

function fromRow(_db: DB, row: ItemRow): BlueprintOptimizationItem {
  return {
    id: row.id,
    blueprintId: row.blueprint_id,
    actionType: row.action_type as BlueprintOptimizationActionType,
    targetBlueprintId: row.target_blueprint_id,
    reason: row.reason,
    expectedEffect: row.expected_effect,
    params: JSON.parse(row.params_json ?? '{}') as Record<string, unknown>,
    status: row.status as BlueprintOptimizationItem['status'],
    createdAt: row.created_at,
  };
}

function insertItem(db: DB, _companyId: string, item: Omit<BlueprintOptimizationItem, 'id' | 'status' | 'createdAt'>): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO blueprint_optimization_item
      (id, blueprint_id, action_type, target_blueprint_id, reason, expected_effect, params_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(shortId('boi_'), item.blueprintId, item.actionType, item.targetBlueprintId ?? null,
    item.reason, item.expectedEffect, JSON.stringify(item.params ?? {}), now);
}

/** 多维评分（与面板一致）：胜率 60% + 低返工 25% + 低纠正 15%；样本 < 3 视为观察中。 */
export function scoreOfBlueprint(bp: Blueprint): number | null {
  const total = bp.wins + bp.losses;
  if (total < 3) return null;
  const winRate = bp.wins / total;
  const reworkRate = Math.min(1, bp.reworkTotal / total);
  const correctionRate = Math.min(1, bp.correctionTotal / total);
  return Math.round((winRate * 0.6 + (1 - reworkRate) * 0.25 + (1 - correctionRate) * 0.15) * 100);
}

/**
 * 插入一条 pending 提案（幂等：同蓝图同动作的 pending 不重复插入）。
 * 优化对话与规则兜底共用；返回是否真的插入（供对话页提示新增了哪几条）。
 */
export function insertPendingOptimizationItem(
  db: DB,
  companyId: string,
  item: Omit<BlueprintOptimizationItem, 'id' | 'status' | 'createdAt'>,
): boolean {
  const exists = db.prepare(
    `SELECT 1 FROM blueprint_optimization_item
      WHERE blueprint_id=? AND action_type=? AND status='pending' LIMIT 1`,
  ).get(item.blueprintId, item.actionType);
  if (exists) return false;
  insertItem(db, companyId, item);
  return true;
}

export function listOptimizationItems(db: DB, _companyId?: string, blueprintId?: string): BlueprintOptimizationItem[] {
  const rows = (blueprintId
    ? db.prepare('SELECT * FROM blueprint_optimization_item WHERE blueprint_id=? ORDER BY created_at DESC').all(blueprintId)
    : db.prepare('SELECT * FROM blueprint_optimization_item ORDER BY created_at DESC').all()) as ItemRow[];
  return rows.map((r) => fromRow(db, r));
}


/** 采纳建议：按动作落地（全部走版本化提交）。返回落地结果。 */
export function applyOptimizationItem(db: DB, itemId: string): { applied: boolean; message: string } {
  const row = db.prepare('SELECT * FROM blueprint_optimization_item WHERE id=?').get(itemId) as ItemRow | undefined;
  if (!row) throw new Error('优化建议不存在');
  if (row.status !== 'pending') return { applied: false, message: '该建议已处理' };
  const item = fromRow(db, row);
  let message = '';
  // 断电安全：动作落地 + 建议状态同事务（嵌套事务自动落 savepoint）——崩溃不会出现"已改蓝图但建议仍 pending"导致的重复采纳
  const applied = db.transaction((): boolean => {
    switch (item.actionType) {
      case 'lock':
        setBlueprintStatus(db, item.blueprintId, 'locked');
        message = '已锁定（冻结进化，仍参与匹配）';
        return true;
      case 'retire':
        setBlueprintStatus(db, item.blueprintId, 'retired');
        message = '已淘汰（不再参与匹配）';
        return true;
      case 'merge': {
        if (!item.targetBlueprintId) { message = '合并缺少目标蓝图'; return false; }
        if (item.targetBlueprintId === item.blueprintId) { message = '不能合并到自身'; return false; }
        const target = getBlueprint(db, item.targetBlueprintId);
        const source = getBlueprint(db, item.blueprintId);
        // 班底并集（≤4 槽）、工具并集（cap 10）、战绩相加
        const staffing = [...target.staffing];
        for (const slot of source.staffing) {
          if (!staffing.some((s) => s.personaId === slot.personaId) && staffing.length < 4) staffing.push(slot);
        }
        const tools = [...target.tools];
        for (const tool of source.tools) {
          const hit = tools.find((t) => t.kind === tool.kind && t.id === tool.id);
          if (hit) { hit.uses += tool.uses; hit.wins += tool.wins; }
          else if (tools.length < 10) tools.push({ ...tool });
        }
        const now = nowIso();
        db.prepare(
          `UPDATE blueprint SET staffing_json=?, tools_json=?,
             wins=?, losses=?, rework_total=?, correction_total=?, updated_at=? WHERE id=?`,
        ).run(
          JSON.stringify(staffing), JSON.stringify(tools),
          target.wins + source.wins, target.losses + source.losses,
          target.reworkTotal + source.reworkTotal, target.correctionTotal + source.correctionTotal,
          now, target.id,
        );
        commitBlueprintVersion(db, target.id, `合并：吸收「${source.label}」的班底/工具/战绩`, [source.id]);
        setBlueprintStatus(db, source.id, 'retired');
        message = `已合并进「${target.label}」，源蓝图退役（可回滚）`;
        return true;
      }
      case 'polish_description': {
        const description = typeof item.params.description === 'string' ? item.params.description.trim() : '';
        if (!description) { message = '建议缺少描述文本'; return false; }
        updateBlueprintDescription(db, item.blueprintId, description);
        message = '描述已更新';
        return true;
      }
    }
  })();
  if (applied) {
    db.prepare("UPDATE blueprint_optimization_item SET status='applied' WHERE id=?").run(itemId);
  }
  return { applied, message };
}

export function ignoreOptimizationItem(db: DB, itemId: string): void {
  db.prepare("UPDATE blueprint_optimization_item SET status='ignored' WHERE id=?").run(itemId);
}
