/**
 * B2B 外包决策树：内部能做吗 → 外包给谁 → 否则招聘。
 *
 * 全自动决策逻辑（用户要求）：
 * 1. 查询甲方公司内部是否有人具备所需能力（capability_binding 有 employee_id 绑定）
 *    → 路径 'internal'，返回可分配的内部员工
 * 2. 否则跨公司扫描所有在营公司，找具备所需能力的乙方
 *    → 路径 'outsource'，返回推荐的乙方公司
 * 3. 都没有 → 路径 'recruit'（本轮记事件 + 提示，不自动跑招聘 wizard）
 *
 * 能力匹配基于 capability_binding 表（migration 0027）：
 *   capability_id 是自由字符串（来自模板安装），同一 capabilityId 跨公司匹配。
 */
import type { DB } from '../db/client';
import { listCompanies } from './company';
import type { Company } from './company';
import { createTempEmployment, findGreyedTempForReuse, reactivateGreyedTemp } from './temp-worker';

export type DecisionPath = 'internal' | 'outsource' | 'recruit';

export interface OutsourcingDecision {
  path: DecisionPath;
  /** internal 路径：推荐的可分配员工 agent id。 */
  internalAssigneeId?: string;
  /** outsource 路径：推荐的乙方公司。 */
  vendorCompany?: Company;
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
  companyId: string,
  capabilityIds: string[],
): boolean {
  if (capabilityIds.length === 0) return true; // 无能力要求视为内部可做
  const placeholders = capabilityIds.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT 1 FROM capability_binding
       WHERE company_id = ? AND capability_id IN (${placeholders})
         AND employee_id IS NOT NULL
       LIMIT 1`,
    )
    .get(companyId, ...capabilityIds) as { '1': number } | undefined;
  return !!row;
}

/**
 * 找到公司内具备指定能力的在线员工（用于 internal 路径推荐 assignee）。
 */
export function findInternalAssignee(
  db: DB,
  companyId: string,
  capabilityIds: string[],
): string | null {
  if (capabilityIds.length === 0) return null;
  const placeholders = capabilityIds.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT cb.employee_id FROM capability_binding cb
       JOIN agent_definition a ON a.id = cb.employee_id
       WHERE cb.company_id = ? AND cb.capability_id IN (${placeholders})
         AND cb.employee_id IS NOT NULL
         AND a.availability_state = 'online'
       LIMIT 1`,
    )
    .get(companyId, ...capabilityIds) as { employee_id: string } | undefined;
  return row?.employee_id ?? null;
}

/**
 * 跨公司扫描，找具备所需能力的乙方公司（排除自身）。
 * 优先返回在营（非归档）公司。
 */
export function findVendorCompany(
  db: DB,
  sourceCompanyId: string,
  capabilityIds: string[],
): Company | null {
  if (capabilityIds.length === 0) return null;
  const placeholders = capabilityIds.map(() => '?').join(',');
  // 查有 capability_binding 命中 + employee_id 的公司，排除甲方自身
  const vendorIds = db
    .prepare(
      `SELECT DISTINCT cb.company_id FROM capability_binding cb
       JOIN company c ON c.id = cb.company_id
       WHERE cb.capability_id IN (${placeholders})
         AND cb.employee_id IS NOT NULL
         AND cb.company_id <> ?
         AND c.archived_at IS NULL
       ORDER BY c.state = 'online' DESC, c.updated_at DESC
       LIMIT 1`,
    )
    .all(...capabilityIds, sourceCompanyId) as { company_id: string }[];
  if (vendorIds.length === 0) return null;
  const companies = listCompanies(db, { activeOnly: true });
  return companies.find((c) => c.id === vendorIds[0].company_id) ?? null;
}

/**
 * 运行完整决策树。
 *
 * @param sourceCompanyId 甲方公司
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
      reason: '甲方公司内部具备所需能力，可内部派发',
      missingCapabilityIds: [],
    };
  }
  // 2. 系统内有无更适合的外包公司？
  const vendor = findVendorCompany(db, sourceCompanyId, requiredCapabilityIds);
  if (vendor) {
    return {
      path: 'outsource',
      vendorCompany: vendor,
      reason: `甲方内部无此能力，系统内 ${vendor.name} 具备，建议外包`,
      missingCapabilityIds: requiredCapabilityIds,
    };
  }
  // 3. 都没有 → 招聘
  return {
    path: 'recruit',
    reason: '甲方与系统内其他公司均无所需能力，建议招聘新员工',
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
  companyId: string,
  capabilityIds: string[],
  role: string,
  opts?: { responsibilities?: string; sourceContractId?: string; executor?: Record<string, unknown>; permissions?: Record<string, unknown>; requesterAgentId?: string },
): TempSelectionResult {
  // ② 复用 greyed 临时工（高星级优先）
  const greyedAgentId = findGreyedTempForReuse(db, companyId, capabilityIds);
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
           JOIN company_employee ce ON ce.legacy_agent_id = cb.employee_id
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
    companyId,
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
