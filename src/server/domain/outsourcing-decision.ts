/**
 * 用工决策树：内部能做吗 → 否则临时工选拔。
 *
 * 蓝图组织批次5：B2B 外包拆件退役——删除"跨公司找乙方"（findVendorCompany 与 outsource 路径）。
 * 新模型里干员/人设/蓝图都是工作台级资产，任何团队都能配任何能力，
 * "跨公司"这个外包的存在理由被架构本身消解；能力缺口统一走临时工选拔（组队/复用路径）。
 *
 * 契约状态机与甲方 repo 交付管线（outsourcing-contract.ts / engine.ts）保留，
 * 待改造为跨项目交付协议（project↔project），不再 company↔company。
 *
 * 1. 甲方内部是否有人具备所需能力（capability_binding 有 employee_id 绑定）
 *    → 路径 'internal'，返回可分配的内部员工
 * 2. 否则 → 路径 'recruit'（临时工选拔链：greyed 复用 → 人才库 → 新建）
 *
 * 能力匹配基于 capability_binding 表：
 *   capability_id 是自由字符串（来自模板安装），同一 capabilityId 可跨任职匹配。
 */
import type { DB } from '../db/client';
import { createTempEmployment, findGreyedTempForReuse, reactivateGreyedTemp } from './temp-worker';

export type DecisionPath = 'internal' | 'recruit';

export interface OutsourcingDecision {
  path: DecisionPath;
  /** internal 路径：推荐的可分配员工 agent id。 */
  internalAssigneeId?: string;
  /** 决策原因（可展示给用户）。 */
  reason: string;
  /** 所需能力中，内部无法满足的部分（gap）。 */
  missingCapabilityIds: string[];
}

/**
 * 查询某公司内部是否有人具备指定能力（任意一项即可）。
 * 匹配条件：capability_binding 有 employee_id（已绑定到员工）且 capability_id 命中。
 */
export function hasInternalCapability(
  db: DB,
  _companyId: string,
  capabilityIds: string[],
): boolean {
  if (capabilityIds.length === 0) return true; // 无能力要求视为内部可做
  const placeholders = capabilityIds.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT 1 FROM capability_binding
       WHERE capability_id IN (${placeholders})
         AND employee_id IS NOT NULL
       LIMIT 1`,
    )
    .get(...capabilityIds) as { '1': number } | undefined;
  return !!row;
}

/**
 * 找到工作台内具备指定能力的在线员工（用于 internal 路径推荐 assignee）。
 */
export function findInternalAssignee(
  db: DB,
  _companyId: string,
  capabilityIds: string[],
): string | null {
  if (capabilityIds.length === 0) return null;
  const placeholders = capabilityIds.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT cb.employee_id FROM capability_binding cb
       JOIN agent_definition a ON a.id = cb.employee_id
       WHERE cb.capability_id IN (${placeholders})
         AND cb.employee_id IS NOT NULL
         AND a.availability_state = 'online'
       LIMIT 1`,
    )
    .get(...capabilityIds) as { employee_id: string } | undefined;
  return row?.employee_id ?? null;
}

/**
 * 运行完整决策树（蓝图组织批次5：两路径——内部 / 临时工选拔）。
 *
 * @param sourceCompanyId 工作台（甲方）
 * @param requiredCapabilityIds 任务所需能力列表
 */
export function runOutsourcingDecisionTree(
  db: DB,
  sourceCompanyId: string,
  requiredCapabilityIds: string[],
): OutsourcingDecision {
  // 1. 内部能否做？
  if (hasInternalCapability(db, sourceCompanyId, requiredCapabilityIds)) {
    const assignee = findInternalAssignee(db, sourceCompanyId, requiredCapabilityIds);
    return {
      path: 'internal',
      internalAssigneeId: assignee ?? undefined,
      reason: '工作台内部具备所需能力，可内部派发',
      missingCapabilityIds: [],
    };
  }
  // 2. 没有 → 临时工选拔（greyed 复用 → 人才库 → 新建；跨公司外包已随批次5退役）
  return {
    path: 'recruit',
    reason: '工作台内无此能力，走临时工选拔（复用候选 → 人才库 → 新建）',
    missingCapabilityIds: requiredCapabilityIds,
  };
}

/**
 * 招聘临时工（决策树 recruit 路径落地）。
 *
 * 选拔优先级链（用户明确要求）：
 *   ① 公司内部选人（hasInternalCapability → 已在决策树外层处理）
 *   ② 复用 greyed 临时工（重新激活，高星级优先）
 *   ③ 人才库选人（is_temp_only=0 的现成 profile）
 *   ④ 创建新临时工（is_temp_only=1）
 *
 * 本函数处理 ②③④（①由决策树外层返回 internal 路径）。
 */
export interface TempSelectionResult {
  /** 'reactivated'（复用 greyed）| 'reused'（人才库）| 'created'（新建）。 */
  path: 'reactivated' | 'reused' | 'created';
  agentId: string;
  profileId: string;
  isNewProfile: boolean;
}

export function selectTempForNeed(
  db: DB,
  capabilityIds: string[],
  role: string,
  opts?: { responsibilities?: string; sourceContractId?: string; executor?: Record<string, unknown>; permissions?: Record<string, unknown>; requesterAgentId?: string },
): TempSelectionResult {
  // ② 复用 greyed 临时工（高星级优先）
  const greyedAgentId = findGreyedTempForReuse(db, capabilityIds);
  if (greyedAgentId) {
    reactivateGreyedTemp(db, greyedAgentId);
    const profileRow = db.prepare('SELECT profile_id FROM agent_definition WHERE id=?').get(greyedAgentId) as { profile_id: string } | undefined;
    return {
      path: 'reactivated',
      agentId: greyedAgentId,
      profileId: profileRow?.profile_id ?? '',
      isNewProfile: false,
    };
  }

  // ③ 人才库选人（is_temp_only=0，具备能力的现成 profile）
  let existingProfileId: string | undefined;
  if (capabilityIds.length > 0) {
    const placeholders = capabilityIds.map(() => '?').join(',');
    const candidate = db.prepare(
      `SELECT ap.id FROM agent_profile ap
       WHERE ap.is_temp_only = 0
         AND EXISTS (
           SELECT 1 FROM capability_binding cb
           JOIN employee ce ON ce.legacy_agent_id = cb.employee_id
           WHERE ce.profile_id = ap.id
             AND cb.capability_id IN (${placeholders})
             AND cb.employee_id IS NOT NULL
         )
       ORDER BY ap.rating DESC
       LIMIT 1`,
    ).get(...capabilityIds) as { id: string } | undefined;
    existingProfileId = candidate?.id;
  }

  // ③④ 走 createTempEmployment（复用 or 新建）
  const result = createTempEmployment(db, {
    profileId: existingProfileId,
    role,
    responsibilities: opts?.responsibilities,
    sourceContractId: opts?.sourceContractId,
    skills: [],
    tools: [],
    executor: opts?.executor,
    permissions: opts?.permissions,
    requesterAgentId: opts?.requesterAgentId,
  });
  return {
    path: existingProfileId ? 'reused' : 'created',
    agentId: result.agentId,
    profileId: result.profileId,
    isNewProfile: result.isNewProfile,
  };
}
