/**
 * B2B 外包交付协调层。
 *
 * 桥接 task 完成 → 契约状态流转 → 甲方验收通知。
 * - 乙方承接任务 completed 时，engine.ts 调 onOutsourcedTaskCompleted，
 *   把契约标记 delivered（产物已在 publish 阶段落到甲方 rootDir）。
 * - 甲方验收通过（submitReview completed）后，契约完成；若有甲方源任务在等待，由 resumeDependents 唤醒。
 */
import type { DB } from '../db/client';
import { getOutsourcingContract, markDelivered, type OutsourcingContract } from './outsourcing-contract';

/**
 * 乙方承接任务完成时调用（engine.ts completeTask 路径）。
 * 幂等：契约非 in_progress 态时跳过（避免重复触发）。
 *
 * 若承接员工是临时工（temp+active），完成后自动 greyed（灰色保留待人工决定）。
 */
export function onOutsourcedTaskCompleted(db: DB, taskId: string): OutsourcingContract | null {
  // 通过 task.outsourcing_contract_id 反查契约
  const row = db
    .prepare('SELECT outsourcing_contract_id, assignee_agent_id FROM task WHERE id = ?')
    .get(taskId) as { outsourcing_contract_id: string | null; assignee_agent_id: string | null } | undefined;
  const contractId = row?.outsourcing_contract_id;
  if (!contractId) return null; // 非外包任务
  const contract = getOutsourcingContract(db, contractId);
  // 仅 in_progress 态触发 delivered（幂等：已 delivered/reviewing 不重复）
  if (contract.state === 'in_progress' && contract.outsourcedTaskId === taskId) {
    // 承接员工若是临时工，完成后自动 greyed
    if (row?.assignee_agent_id) {
      markTempGreyedIfTemp(db, row.assignee_agent_id);
    }
    return markDelivered(db, contractId);
  }
  return contract;
}

/** 若该 agent 是临时工（temp+active），标记为 greyed；非临时工无操作。 */
function markTempGreyedIfTemp(db: DB, agentId: string): void {
  const row = db
    .prepare('SELECT employment_type, temp_status FROM company_employee WHERE legacy_agent_id=?')
    .get(agentId) as { employment_type: string; temp_status: string | null } | undefined;
  if (!row) return;
  if (row.employment_type === 'temp' && row.temp_status === 'active') {
    db.prepare(
      `UPDATE company_employee SET temp_status='greyed', updated_at=datetime('now') WHERE legacy_agent_id=?`,
    ).run(agentId);
  }
}
