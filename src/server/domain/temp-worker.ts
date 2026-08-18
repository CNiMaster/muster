/**
 * 临时工生命周期领域层（批次 A）。
 *
 * 临时工是 B2B 外包决策树 recruit 路径的落地：自动从人才市场找/新建 →
 * 完成工作后灰色保留（不启用）→ 人工决定转正或开除。
 *
 * 两种来源决定开除处理：
 *   is_temp_only=0（人才市场来的人）：开除只删任职，profile + Agent Home 保留
 *   is_temp_only=1（临时新建、未转正）：开除连 profile + Agent Home 一起删，不进人才市场
 *
 * 详见 docs/superpowers/specs/2026-08-10-temp-worker-and-handover-design.md。
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso } from '../../shared/utils';
import { createAgent, getAgent } from './agent';
import { createAgentProfile, getAgentProfile } from './agent-profile';
import { getAgentHomePath } from './agent-home';
import { getWorkbench } from './workbench';
import { bindDefaultDenyPolicy, getRoleTemplate, TEMPLATE_NAMES } from './permission-templates';
import { getEmployeePermissionPolicy, bindEmployeePermissionPolicy } from './permission';

/** 临时工状态（仅 employment_type='temp' 有意义）。 */
export type TempStatus = 'active' | 'greyed' | 'dismissed';

export interface CreateTempEmploymentInput {
  /** 复用人才市场现有人；不传则新建（is_temp_only=1）。 */
  profileId?: string;
  role: string;
  responsibilities?: string;
  /** 来源外包契约（可空，手动招临时工时无）。 */
  sourceContractId?: string;
  /** 所需能力（新建 profile 时写入 capabilities）。 */
  skills?: string[];
  tools?: string[];
  /** 默认 executor/permission（从公司配置派生；不传用 profile 推荐）。 */
  executor?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  /** 发起需求的员工 agent id —— 临时工的工作关系仅限此人（小范围，不影响其他人）。 */
  requesterAgentId?: string;
  /** 指挥系统：蜂群工蜂的显示名与提示词（不传用默认"临时工-{role}"）。 */
  name?: string;
  systemPrompt?: string;
}

export interface TempEmploymentResult {
  /** agent_definition id（= company_employee.legacy_agent_id）。 */
  agentId: string;
  profileId: string;
  /** 是否新建的 profile（true=is_temp_only=1，未转正开除会连 profile 删）。 */
  isNewProfile: boolean;
}

/**
 * 招聘临时工（临时工招聘唯一入口）。
 * - profileId 有：复用人才市场的人（is_temp_only 不变）
 * - profileId 无：新建 profile 并标 is_temp_only=1（临时创建，未转正不进人才市场）
 * 走 createAgent 但用 tempRecruit 豁免（允许 online 态招临时工）。
 */
export function createTempEmployment(db: DB, input: CreateTempEmploymentInput): TempEmploymentResult {
  getWorkbench(db); // 工作台存在性校验（单例不归档，无需 archivedAt 检查）

  let profileId = input.profileId;
  let isNewProfile = false;

  if (!profileId) {
    // 新建临时 profile（is_temp_only=1）
    const displayName = input.name ?? `临时工-${input.role}`;
    const profile = createAgentProfile(db, {
      displayName,
      soul: input.systemPrompt ?? `你是${displayName}，临时岗位是${input.role}。${input.responsibilities ?? ''}`,
      capabilities: { skills: input.skills ?? [], tools: input.tools ?? [] },
      recommendedExecutor: input.executor,
      recommendedPermission: input.permissions,
    });
    profileId = profile.id;
    isNewProfile = true;
    db.prepare('UPDATE agent_profile SET is_temp_only=1 WHERE id=?').run(profileId);
  } else {
    // 复用现有人，校验存在
    getAgentProfile(db, profileId);
  }

  // 走 createAgent（tempRecruit 豁免 org lock）
  // 临时工的工作关系仅限发起者（小范围，对其他人隐形）——contactAllow 只含 requester
  const agent = createAgent(db, {
    profileId,
    name: getAgentProfile(db, profileId).displayName,
    role: input.role,
    responsibilities: input.responsibilities,
    systemPrompt: input.systemPrompt,
    skills: input.skills,
    tools: input.tools,
    executor: input.executor,
    permissions: input.permissions,
    contactAllow: input.requesterAgentId ? [input.requesterAgentId] : [],
    tempRecruit: true, // 豁免 org lock
  });

  // 标记为临时工：更新 company_employee
  const now = nowIso();
  db.prepare(
    `UPDATE company_employee
     SET employment_type='temp', temp_status='active', contracted_at=?, source_contract_id=?
     WHERE legacy_agent_id=?`,
  ).run(now, input.sourceContractId ?? null, agent.id);

  // R1：默认绑定「临时工」deny 权限档（API 执行器上不再零拦截；显式策略不覆盖）。
  bindDefaultDenyPolicy(db, agent.id);

  return { agentId: agent.id, profileId, isNewProfile };
}

/**
 * 转正：临时工 → 正式员工。
 * - employment_type → permanent, temp_status → NULL
 * - 若 is_temp_only=1 → 清零（正式进入人才市场）
 */
export function convertTempToPermanent(db: DB, agentId: string): void {
  const agent = getAgent(db, agentId);
  const row = db
    .prepare('SELECT employment_type, temp_status FROM company_employee WHERE legacy_agent_id=?')
    .get(agentId) as { employment_type: string; temp_status: TempStatus | null } | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `任职记录不存在：${agentId}`);
  if (row.employment_type !== 'temp') {
    throw new AppError(ErrorCode.VALIDATION, '该员工不是临时工，无需转正');
  }
  db.prepare(
    `UPDATE company_employee SET employment_type='permanent', temp_status=NULL, updated_at=? WHERE legacy_agent_id=?`,
  ).run(nowIso(), agentId);
  // 若是临时新建的 profile，转正时清零 is_temp_only，正式进入人才市场
  db.prepare('UPDATE agent_profile SET is_temp_only=0 WHERE id=?').run(agent.profileId);
  // Review 修复 I4：转正时若仍绑着默认 deny 临时工档，重绑为「员工」档（ask-by-rule）——
  // 否则转正员工在 API 执行器上持续全拒。显式绑定的其他策略不覆盖。
  try {
    const employment = db
      .prepare('SELECT id FROM company_employee WHERE legacy_agent_id=?')
      .get(agentId) as { id: string } | undefined;
    if (employment) {
      const current = getEmployeePermissionPolicy(db, employment.id);
      if (current?.name === TEMPLATE_NAMES.temp) {
        bindEmployeePermissionPolicy(db, employment.id, getRoleTemplate(db, 'employee').id, { skipLock: true });
      }
    }
  } catch {
    // 重绑失败不阻断转正（用户可手动调整权限档）
  }
}

/**
 * 临时工完成工作 → 灰色保留（不启用，待人工决定）。
 * temp_status: active → greyed。greyed 不参与派工（claimNextTask 排除）。
 */
export function markTempGreyed(db: DB, agentId: string): void {
  const row = db
    .prepare('SELECT employment_type, temp_status FROM company_employee WHERE legacy_agent_id=?')
    .get(agentId) as { employment_type: string; temp_status: TempStatus | null } | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `任职记录不存在：${agentId}`);
  if (row.employment_type !== 'temp') return; // 非临时工无操作
  if (row.temp_status !== 'active') return; // 非 active 不重复触发
  db.prepare(
    `UPDATE company_employee SET temp_status='greyed', updated_at=? WHERE legacy_agent_id=?`,
  ).run(nowIso(), agentId);
}

/**
 * 找到该公司具备指定能力的 greyed 临时工（选拔优先级链第二级：优先复用 greyed）。
 * 匹配：employment_type='temp' AND temp_status='greyed' AND 具备所需能力。
 */
export function findGreyedTempForReuse(
  db: DB,
  capabilityIds: string[],
): string | null {
  if (capabilityIds.length === 0) {
    // 无能力要求：返回任意 greyed 临时工
    const row = db
      .prepare(
        `SELECT ce.legacy_agent_id FROM company_employee ce
         WHERE ce.employment_type = 'temp' AND ce.temp_status = 'greyed'
         ORDER BY ce.updated_at DESC LIMIT 1`,
      )
      .get() as { legacy_agent_id: string } | undefined;
    return row?.legacy_agent_id ?? null;
  }
  const placeholders = capabilityIds.map(() => '?').join(',');
  // 临时工的能力通过 capability_binding 匹配；高星级优先
  const row = db
    .prepare(
      `SELECT ce.legacy_agent_id FROM company_employee ce
       JOIN agent_profile ap ON ap.id = ce.profile_id
       WHERE ce.employment_type = 'temp' AND ce.temp_status = 'greyed'
         AND EXISTS (
           SELECT 1 FROM capability_binding cb
           WHERE cb.employee_id = ce.legacy_agent_id
             AND cb.capability_id IN (${placeholders})
         )
       ORDER BY ap.rating DESC, ce.updated_at DESC LIMIT 1`,
    )
    .get(...capabilityIds) as { legacy_agent_id: string } | undefined;
  return row?.legacy_agent_id ?? null;
}

/**
 * 重新激活 greyed 临时工（下次项目需要时优先复用，而非新建）。
 * temp_status: greyed → active。重新参与派工。
 * 选拔优先级链：公司内部 → greyed 临时工 → 人才库 → 创建新临时工。
 */
export function reactivateGreyedTemp(db: DB, agentId: string): void {
  const row = db
    .prepare('SELECT employment_type, temp_status FROM company_employee WHERE legacy_agent_id=?')
    .get(agentId) as { employment_type: string; temp_status: TempStatus | null } | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `任职记录不存在：${agentId}`);
  if (row.employment_type !== 'temp') {
    throw new AppError(ErrorCode.VALIDATION, '该员工不是临时工');
  }
  if (row.temp_status !== 'greyed') {
    throw new AppError(ErrorCode.VALIDATION, `临时工状态 ${row.temp_status}，仅 greyed 可重新激活`);
  }
  db.prepare(
    `UPDATE company_employee SET temp_status='active', updated_at=? WHERE legacy_agent_id=?`,
  ).run(nowIso(), agentId);
  // R1：greyed 复用时确保 deny 档在（旧数据创建的临时工可能没有策略绑定）。
  bindDefaultDenyPolicy(db, agentId);
}

export interface DismissTempOptions {
  /** 删 Agent Home 前的二次确认（API 层强制要求 confirm=true）。 */
  confirm: boolean;
  /** musterHome 路径（测试用，缺省读 SERVER_CONFIG）。 */
  musterHome?: string;
}

/**
 * 开除临时工。两种来源不同处理：
 * - is_temp_only=0（人才市场来的人）：删任职 + 清理该公司记忆分区；profile + Home 保留
 * - is_temp_only=1（临时新建、未转正）：删任职 + 删 profile + 删 Home（彻底，不进人才市场）
 *
 * 注：完整离职交接（批次 C handover_record）尚未实现；本轮先支持直接开除，
 * 批次 C 会在开除前接入交接工作流（产物 owner 转移等）。
 */
export function dismissTempWorker(db: DB, agentId: string, opts: DismissTempOptions): void {
  if (!opts.confirm) {
    throw new AppError(ErrorCode.VALIDATION, '开除临时工需二次确认（confirm=true）');
  }
  const agent = getAgent(db, agentId);
  const row = db
    .prepare(
      `SELECT ce.employment_type, ce.temp_status, ap.is_temp_only
       FROM company_employee ce JOIN agent_profile ap ON ap.id = ce.profile_id
       WHERE ce.legacy_agent_id=?`,
    )
    .get(agentId) as { employment_type: string; temp_status: TempStatus | null; is_temp_only: number } | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `任职记录不存在：${agentId}`);
  if (row.employment_type !== 'temp') {
    throw new AppError(ErrorCode.VALIDATION, '该员工不是临时工');
  }

  const profileId = agent.profileId;
  const companyId = agent.companyId;

  // 先删任职（tempRecruit 豁免 org lock，开除也豁免——临时工本来就在线招的）
  // deleteAgent 内部 assertUnlocked，临时工开除应放行：直接走事务删
  db.transaction(() => {
    db.prepare('DELETE FROM agent_definition WHERE id=?').run(agentId);
  })();

  if (row.is_temp_only === 1) {
    // 临时新建、未转正：连 profile + Agent Home 一起删，不进人才市场
    // 校验该 profile 没有其他任职（防止误删多任职的人）
    const otherEmployments = db
      .prepare('SELECT COUNT(*) AS c FROM company_employee WHERE profile_id=?')
      .get(profileId) as { c: number };
    if (otherEmployments.c > 0) {
      // 还有其他任职（虽然 is_temp_only=1 但被复用了），只清记忆分区，不删 profile/Home
      cleanupCompanyMemoryPartition(profileId, companyId, opts.musterHome);
    } else {
      // 彻底删除
      cleanupCompanyMemoryPartition(profileId, companyId, opts.musterHome);
      db.prepare('DELETE FROM agent_profile WHERE id=?').run(profileId);
      // 删除整个 Agent Home（唯一删 Home 的场景）
      const home = getAgentHomePath(profileId, opts.musterHome);
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // Home 不存在或删除失败不阻塞（可能从未 materialize）
      }
    }
  } else {
    // 人才市场来的人：profile + Home 保留，只清理该公司记忆分区
    cleanupCompanyMemoryPartition(profileId, companyId, opts.musterHome);
  }
}

/** 清理 Agent Home 中某公司的记忆分区目录（companies/{companyId}/）。 */
function cleanupCompanyMemoryPartition(profileId: string, companyId: string, musterHome?: string): void {
  const home = getAgentHomePath(profileId, musterHome);
  const companyDir = path.join(home, 'companies', companyId);
  try {
    rmSync(companyDir, { recursive: true, force: true });
  } catch {
    // 目录不存在不阻塞
  }
}
