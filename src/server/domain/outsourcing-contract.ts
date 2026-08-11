/**
 * B2B 跨组织任务委派（外包）契约领域层。
 *
 * 「公司」是软件内的本地组织概念，非真实企业实体。本模块管理甲方（source）向乙方（target）
 * 委派任务的全生命周期契约。
 *
 * 状态机：
 *   pending（待乙方接受）→ accepted → in_progress → delivered（乙方完工）
 *     → reviewing（甲方验收）→ completed | changes_requested（→ in_progress 返工）| rejected
 *
 * 文件交付：乙方承接任务的 worktree 基于甲方 source_project 的 git repo 切出（engine.ts 处理），
 * publish 目标指向甲方 rootDir 的 deliverable_dir 子目录。
 *
 * 详见 docs/superpowers/specs/2026-08-10-b2b-outsourcing-design.md。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { DEFAULT_MAX_AUTO_REVIEW_ROUNDS, DEFAULT_AUTO_ACCEPT_MAX_ATTEMPTS } from '../../shared/constants';
import { getCompany } from './company';
import { createProject, getProject } from './project';
import { createTask, getTask, addDependency, type AcceptanceItem, type CreateTaskInput } from './task';
import { appendTaskEvent } from './task-event';
import { listAgents } from './agent';

/**
 * 自动接受失败的退避表（毫秒）：第 1/2/3/4+ 次失败的等待间隔。
 * 避免 coordinator 每 2s tick 反复 accept→失败→revert 空转。
 * 上限 15 分钟——足够让运维发现并修复配置问题，又不至于过久卡住可恢复的瞬态失败。
 */
const AUTO_ACCEPT_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000];

/** 契约状态。 */
export type ContractState =
  | 'pending' // 待乙方接受
  | 'accepted' // 乙方已接受，待开始执行
  | 'in_progress' // 乙方执行中
  | 'delivered' // 乙方完工，待甲方验收
  | 'reviewing' // 甲方验收中
  | 'changes_requested' // 甲方要求返工（自动回流 in_progress）
  | 'completed' // 验收通过，契约完成
  | 'rejected' // 甲方拒绝交付
  | 'cancelled' // 任一方取消
  | 'auto_accept_disabled'; // 自动接受连续失败达上限，停止空转，待人工修复乙方配置

/** 契约实体。 */
export interface OutsourcingContract {
  id: string;
  sourceCompanyId: string; // 甲方
  targetCompanyId: string; // 乙方
  sourceProjectId: string; // 甲方委派源项目
  sourceTaskId: string | null; // 甲方发起委派的任务（可选，用户手动发起时可能无）
  outsourcedTaskId: string | null; // 乙方承接的任务（接受后创建）
  title: string;
  brief: string; // 任务简报（"公司需求"）
  acceptanceCriteria: AcceptanceItem[]; // 验收标准
  requiredCapabilityIds: string[]; // 所需能力（决策树用）
  deliverableDir: string | null; // 甲方项目内指定交付子目录
  readonlyRefs: string[]; // 授予乙方只读的甲方资料路径
  state: ContractState;
  vendorLiaisonAgentId: string | null; // 乙方对接人
  dispatcherAgentId: string | null; // 甲方发起对接人
  feedback: string | null; // 验收反馈
  revisionRound: number;
  /** 自动接受连续失败次数（成功接受后清零，仅 coordinator 自动路径维护）。 */
  autoAcceptAttemptCount: number;
  /** 下次允许自动接受的时间（ISO）；未设置则无限制。退避避免每 tick 空转。 */
  autoAcceptAfterAt: string | null;
  /** 自动接受连续失败上限（默认 8）；达上限转 auto_accept_disabled 终态。 */
  autoAcceptMaxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

interface ContractRow {
  id: string;
  source_company_id: string;
  target_company_id: string;
  source_project_id: string;
  source_task_id: string | null;
  outsourced_task_id: string | null;
  title: string;
  brief: string;
  acceptance_criteria_json: string;
  required_capability_ids_json: string;
  deliverable_dir: string | null;
  readonly_refs_json: string;
  state: string;
  vendor_liaison_agent_id: string | null;
  dispatcher_agent_id: string | null;
  feedback_json: string | null;
  revision_round: number;
  auto_accept_attempt_count: number;
  auto_accept_after_at: string | null;
  auto_accept_max_attempts: number;
  created_at: string;
  updated_at: string;
}

function fromRow(r: ContractRow): OutsourcingContract {
  return {
    id: r.id,
    sourceCompanyId: r.source_company_id,
    targetCompanyId: r.target_company_id,
    sourceProjectId: r.source_project_id,
    sourceTaskId: r.source_task_id,
    outsourcedTaskId: r.outsourced_task_id,
    title: r.title,
    brief: r.brief,
    acceptanceCriteria: JSON.parse(r.acceptance_criteria_json ?? '[]') as AcceptanceItem[],
    requiredCapabilityIds: JSON.parse(r.required_capability_ids_json ?? '[]') as string[],
    deliverableDir: r.deliverable_dir,
    readonlyRefs: JSON.parse(r.readonly_refs_json ?? '[]') as string[],
    state: r.state as ContractState,
    vendorLiaisonAgentId: r.vendor_liaison_agent_id,
    dispatcherAgentId: r.dispatcher_agent_id,
    feedback: r.feedback_json,
    revisionRound: r.revision_round,
    autoAcceptAttemptCount: r.auto_accept_attempt_count ?? 0,
    autoAcceptAfterAt: r.auto_accept_after_at ?? null,
    autoAcceptMaxAttempts: r.auto_accept_max_attempts ?? DEFAULT_AUTO_ACCEPT_MAX_ATTEMPTS,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 允许的状态迁移。 */
const ALLOWED_TRANSITIONS: Record<ContractState, ContractState[]> = {
  pending: ['accepted', 'cancelled', 'auto_accept_disabled'],
  // Review 修复（M-1）：accepted → pending 仅供接受端失败回滚（revertAcceptToPending），
  // 使契约可重新接受，避免 createOutsourcedTask 失败后契约永久卡在 accepted。
  // B3：accepted → auto_accept_disabled 供自动接受连续失败达上限时转永久终态。
  accepted: ['in_progress', 'cancelled', 'pending', 'auto_accept_disabled'],
  in_progress: ['delivered', 'cancelled'],
  delivered: ['reviewing', 'cancelled'],
  reviewing: ['completed', 'changes_requested', 'rejected'],
  changes_requested: ['in_progress'],
  completed: [],
  rejected: [],
  cancelled: [],
  // B3 终态：自动接受失败封顶。允许人工修复乙方配置后手动迁回 pending 重新接受。
  auto_accept_disabled: ['pending'],
};

function assertTransition(from: ContractState, to: ContractState): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new AppError(ErrorCode.VALIDATION, `非法契约迁移：${from} → ${to}`);
  }
}

export interface CreateContractInput {
  sourceCompanyId: string;
  targetCompanyId: string;
  sourceProjectId: string;
  sourceTaskId?: string;
  dispatcherAgentId?: string;
  title: string;
  brief: string;
  acceptanceCriteria?: AcceptanceItem[];
  requiredCapabilityIds?: string[];
  deliverableDir?: string;
  readonlyRefs?: string[];
}

/** 创建外包契约（pending 态，待乙方接受）。 */
export function createOutsourcingContract(db: DB, input: CreateContractInput): OutsourcingContract {
  if (input.sourceCompanyId === input.targetCompanyId) {
    throw new AppError(ErrorCode.VALIDATION, '不能向自身公司外包');
  }
  // 校验公司与项目归属
  const sourceCompany = getCompany(db, input.sourceCompanyId);
  const targetCompany = getCompany(db, input.targetCompanyId);
  if (sourceCompany.state !== 'online' && sourceCompany.state !== 'review_paused') {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '甲方公司未上线，无法发起委派');
  }
  if (targetCompany.archivedAt) {
    throw new AppError(ErrorCode.VALIDATION, '乙方公司已归档，无法承接委派');
  }

  const id = shortId('oc_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO outsourcing_contract
      (id, source_company_id, target_company_id, source_project_id, source_task_id, outsourced_task_id,
       title, brief, acceptance_criteria_json, required_capability_ids_json, deliverable_dir, readonly_refs_json,
       state, vendor_liaison_agent_id, dispatcher_agent_id, feedback_json, revision_round, created_at, updated_at)
     VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,'pending',NULL,?,NULL,0,?,?)`,
  ).run(
    id,
    input.sourceCompanyId,
    input.targetCompanyId,
    input.sourceProjectId,
    input.sourceTaskId ?? null,
    input.title,
    input.brief,
    JSON.stringify(input.acceptanceCriteria ?? []),
    JSON.stringify(input.requiredCapabilityIds ?? []),
    input.deliverableDir ?? null,
    JSON.stringify(input.readonlyRefs ?? []),
    input.dispatcherAgentId ?? null,
    now,
    now,
  );
  return getOutsourcingContract(db, id);
}

export function getOutsourcingContract(db: DB, id: string): OutsourcingContract {
  const row = db.prepare('SELECT * FROM outsourcing_contract WHERE id = ?').get(id) as
    | ContractRow
    | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `外包契约 ${id} 不存在`);
  return fromRow(row);
}

/** 列出某公司参与的契约（按角色：source=甲方委派出去的 / target=乙方承接的）。 */
export function listContractsForCompany(
  db: DB,
  companyId: string,
  role: 'source' | 'target',
): OutsourcingContract[] {
  const col = role === 'source' ? 'source_company_id' : 'target_company_id';
  const rows = db
    .prepare(`SELECT * FROM outsourcing_contract WHERE ${col} = ? ORDER BY updated_at DESC`)
    .all(companyId) as ContractRow[];
  return rows.map(fromRow);
}

function updateState(db: DB, id: string, newState: ContractState, extra?: Record<string, unknown>): void {
  const cur = getOutsourcingContract(db, id);
  assertTransition(cur.state, newState);
  const now = nowIso();
  const sets = ['state = ?', 'updated_at = ?'];
  const params: unknown[] = [newState, now];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      sets.push(`${k} = ?`);
      params.push(v);
    }
  }
  params.push(id);
  db.prepare(`UPDATE outsourcing_contract SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * 乙方接受契约。
 * @param vendorLiaisonAgentId 乙方对接人（负责人）的 agent id，必须属于乙方公司
 */
export function acceptContract(
  db: DB,
  id: string,
  vendorLiaisonAgentId: string,
  opts: { resetBackoff?: boolean } = {},
): OutsourcingContract {
  const contract = getOutsourcingContract(db, id);
  if (contract.state !== 'pending') {
    throw new AppError(ErrorCode.VALIDATION, `契约 ${id} 当前状态 ${contract.state}，不可接受`);
  }
  // 校验对接人属于乙方
  const liaison = db
    .prepare('SELECT company_id FROM agent_definition WHERE id = ?')
    .get(vendorLiaisonAgentId) as { company_id: string } | undefined;
  if (!liaison) throw new AppError(ErrorCode.NOT_FOUND, `对接人 ${vendorLiaisonAgentId} 不存在`);
  if (liaison.company_id !== contract.targetCompanyId) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '对接人不属于乙方公司');
  }
  // Review 修复（M-1 退避）：手动接受（默认）清零退避计数。
  // B3 修正：自动路径（resetBackoff=false）不清零——否则「accept→createOutsourcedTask 失败→revert」
  // 循环里每次 accept 都把计数重置为 0，退避永远不升级、封顶也永远触发不了。计数改在真正成功
  // （markInProgress：承接任务创建成功）或手动接受时清零。
  const resetBackoff = opts.resetBackoff ?? true;
  const extra: Record<string, unknown> = { vendor_liaison_agent_id: vendorLiaisonAgentId };
  if (resetBackoff) {
    extra.auto_accept_attempt_count = 0;
    extra.auto_accept_after_at = null;
  }
  updateState(db, id, 'accepted', extra);
  return getOutsourcingContract(db, id);
}

/**
 * Review 修复（M-1）：接受端失败回滚——把已 accepted 的契约退回 pending 并清空对接人，
 * 使契约可被重新接受。仅供 accept 后创建承接任务失败时恢复用（coordinator / API 调用）。
 *
 * @param autoBackoff 自动路径（coordinator）传 true：累加 auto_accept_attempt_count 并按
 *   AUTO_ACCEPT_BACKOFF_MS 设下次允许自动接受的时间，避免每 tick 空转。手动路径（API）传
 *   false（默认）：用户主动重试，不加退避。
 */
export function revertAcceptToPending(db: DB, id: string, autoBackoff = false): OutsourcingContract {
  const contract = getOutsourcingContract(db, id);
  if (contract.state !== 'accepted') return contract; // 非 accepted 状态无需回滚（幂等）
  if (autoBackoff) {
    const nextAttempt = contract.autoAcceptAttemptCount + 1;
    const maxAttempts = contract.autoAcceptMaxAttempts || DEFAULT_AUTO_ACCEPT_MAX_ATTEMPTS;
    // B3 封顶：连续失败达上限 → 转 auto_accept_disabled 终态，停止空转，待人工修复乙方配置。
    if (nextAttempt > maxAttempts) {
      updateState(db, id, 'auto_accept_disabled', {
        vendor_liaison_agent_id: null,
        auto_accept_attempt_count: nextAttempt,
        auto_accept_after_at: null,
      });
      if (contract.sourceTaskId) {
        appendTaskEvent(db, contract.sourceTaskId, 'outsourcing_auto_accept_disabled', {
          contractId: id,
          attempts: nextAttempt,
          maxAttempts,
        });
      }
      return getOutsourcingContract(db, id);
    }
    const backoffMs = AUTO_ACCEPT_BACKOFF_MS[Math.min(nextAttempt - 1, AUTO_ACCEPT_BACKOFF_MS.length - 1)]!;
    const afterAt = new Date(Date.now() + backoffMs).toISOString();
    updateState(db, id, 'pending', {
      vendor_liaison_agent_id: null,
      auto_accept_attempt_count: nextAttempt,
      auto_accept_after_at: afterAt,
    });
  } else {
    updateState(db, id, 'pending', { vendor_liaison_agent_id: null });
  }
  return getOutsourcingContract(db, id);
}

/**
 * 阶段四任务 4.1：乙方自动接受契约（AI 对 AI 全自动对接）。
 * - 乙方必须在线（online）。
 * - 公司可关闭自动接受：contractJson.autoAcceptOutsourcing === false 时不自动接。
 * - 对接人选择：按 requiredCapabilityIds 匹配乙方在线员工 skills；
 *   无匹配时选乙方第一负责人；乙方无在线员工则等待人工。
 * 返回 null 表示未接受（条件不满足），返回契约表示已接受（或已非 pending）。
 */
export function autoAcceptContract(db: DB, id: string): OutsourcingContract | null {
  const contract = getOutsourcingContract(db, id);
  if (contract.state !== 'pending') return contract;
  // Review 修复（M-1 退避）：未到退避释放时间则跳过，避免每 tick 反复尝试持续失败的契约。
  if (contract.autoAcceptAfterAt && new Date(contract.autoAcceptAfterAt).getTime() > Date.now()) {
    return null;
  }
  // B3 封顶预检：连续失败次数已达上限 → 在 accept 前转 auto_accept_disabled 终态（真正 honoring「上限 N 次」，
  // 否则按 nextAttempt>max 的回滚式判定会多放行一次）。revertAcceptToPending 里的封顶仍作为直调 acceptContract 的兜底。
  if (contract.autoAcceptAttemptCount >= contract.autoAcceptMaxAttempts) {
    updateState(db, id, 'auto_accept_disabled', { vendor_liaison_agent_id: null });
    if (contract.sourceTaskId) {
      appendTaskEvent(db, contract.sourceTaskId, 'outsourcing_auto_accept_disabled', {
        contractId: id,
        attempts: contract.autoAcceptAttemptCount,
        maxAttempts: contract.autoAcceptMaxAttempts,
      });
    }
    return getOutsourcingContract(db, id);
  }
  const targetCompany = getCompany(db, contract.targetCompanyId);
  if (targetCompany.state !== 'online') return null;
  // 自动接受开关（公司章程可配），默认开启
  const contractJson = (targetCompany.contractJson ?? {}) as Record<string, unknown>;
  if (contractJson.autoAcceptOutsourcing === false) return null;

  const required = contract.requiredCapabilityIds ?? [];
  const agents = listAgents(db, contract.targetCompanyId);
  const online = agents.filter((a) => a.availabilityState === 'online');
  // 优先：能力匹配（requiredCapabilityIds ∩ skills）；
  // Review 修复（L-8）：required 为空时原写法 `.find(() => true)` 直接取 online[0]（创建顺序），
  // 「次选第一负责人」分支永远走不到——改为无能力要求时不走能力匹配，直接进第一负责人优选。
  let liaison = required.length > 0
    ? online.find((a) => required.some((cap) => (a.skills ?? []).includes(cap)))
    : undefined;
  if (!liaison) {
    // 次选：乙方第一负责人（无能力要求或能力无匹配时都走这里）
    const firstAgentId = targetCompany.firstAgentId;
    liaison = online.find((a) => a.id === firstAgentId) ?? online[0];
  }
  if (!liaison) return null; // 乙方无在线员工：等待人工
  // B3：自动路径不清零退避计数（见 acceptContract 注释），使退避能升级、封顶可达。
  return acceptContract(db, id, liaison.id, { resetBackoff: false });
}

/**
 * 标记契约进入执行中（乙方承接任务创建后调用）。
 */
export function markInProgress(db: DB, id: string, outsourcedTaskId: string): OutsourcingContract {
  // B3：承接任务创建成功 = 真正成功，清零自动接受退避计数。
  updateState(db, id, 'in_progress', {
    outsourced_task_id: outsourcedTaskId,
    auto_accept_attempt_count: 0,
    auto_accept_after_at: null,
  });
  return getOutsourcingContract(db, id);
}

/**
 * 标记契约进入验收中（reviewing）。
 * 阶段四任务 4.2：自动验收派发 [验收] Task 时调用（与 submitReview 的隐式 reviewing 等效）。
 */
export function markReviewing(db: DB, id: string): OutsourcingContract {
  const contract = getOutsourcingContract(db, id);
  if (contract.state !== 'delivered') {
    // 幂等：已是 reviewing 或更后状态时不重复迁移
    return contract;
  }
  updateState(db, id, 'reviewing');
  return getOutsourcingContract(db, id);
}

/**
 * 乙方完工标记，状态 → delivered（待甲方验收）。
 * 由 outsourcing-delivery.ts 在乙方承接任务完成后调用。
 */
export function markDelivered(db: DB, id: string): OutsourcingContract {
  updateState(db, id, 'delivered');
  return getOutsourcingContract(db, id);
}

export type ReviewDecision = 'completed' | 'changes_requested' | 'rejected';

/**
 * 甲方验收。
 * - completed → 契约完成（产物回传由 delivery 层处理）
 * - changes_requested → 回流 in_progress，revisionRound++（返工任务由调用方创建）
 * - rejected → 契约终止
 */
export function submitReview(
  db: DB,
  id: string,
  decision: ReviewDecision,
  feedback?: string,
): OutsourcingContract {
  const contract = getOutsourcingContract(db, id);
  // delivered → reviewing（隐式进入验收）
  if (contract.state === 'delivered') {
    updateState(db, id, 'reviewing');
  }
  if (decision === 'completed') {
    updateState(db, id, 'completed', { feedback_json: feedback ?? null });
  } else if (decision === 'changes_requested') {
    // Review 修复（M-3）：返工上限下沉到 submitReview——手动 API 路径此前绕过 maxAutoReviewRounds，
    // 可无限往返返工环。这里与自动验收共用同一阈值（甲方公司 contractJson.maxAutoReviewRounds，默认 3）。
    const maxRounds = getMaxReviewRounds(db, contract);
    if (contract.revisionRound + 1 > maxRounds) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `已达返工上限 ${maxRounds} 轮，请改选 completed 或 rejected 结束验收`,
      );
    }
    // changes_requested 先置中间态，再回流 in_progress（由调用方调 createReworkTask 创建返工任务）
    // 注意：保留 outsourcedTaskId 不清空 —— createReworkTask 需读它定位承接项目，
    // 创建返工任务后由 markInProgress 覆盖为新的返工任务 id。
    updateState(db, id, 'changes_requested', {
      feedback_json: feedback ?? null,
      revision_round: contract.revisionRound + 1,
    });
    updateState(db, id, 'in_progress');
  } else {
    updateState(db, id, 'rejected', { feedback_json: feedback ?? null });
  }
  return getOutsourcingContract(db, id);
}

/** 读取甲方公司配置的返工轮次上限（contractJson.maxAutoReviewRounds，默认 3）。 */
function getMaxReviewRounds(db: DB, contract: OutsourcingContract): number {
  try {
    const project = getProject(db, contract.sourceProjectId);
    const company = project ? getCompany(db, project.companyId) : null;
    const contractJson = (company?.contractJson ?? {}) as Record<string, unknown>;
    return typeof contractJson.maxAutoReviewRounds === 'number' && contractJson.maxAutoReviewRounds > 0
      ? Math.floor(contractJson.maxAutoReviewRounds)
      : DEFAULT_MAX_AUTO_REVIEW_ROUNDS;
  } catch {
    return DEFAULT_MAX_AUTO_REVIEW_ROUNDS;
  }
}

/** 取消契约（任一方）。 */
export function cancelContract(db: DB, id: string): OutsourcingContract {
  const contract = getOutsourcingContract(db, id);
  if (contract.state === 'completed' || contract.state === 'rejected') {
    throw new AppError(ErrorCode.VALIDATION, `契约 ${id} 已终态（${contract.state}），不可取消`);
  }
  updateState(db, id, 'cancelled');
  return getOutsourcingContract(db, id);
}

// ── 跨公司承接任务创建（外包专用入口）──────────────────────────────────────

/**
 * 为乙方创建承接任务（跨公司任务派发的唯一入口）。
 *
 * 流程：
 * 1. 在乙方公司创建/复用承接项目（状态 active，跳过准备流程）
 * 2. 在该项目下创建承接任务，assignee = 乙方对接人
 * 3. 通过 outsourcingContext 绕过同公司守卫（承接任务虽在乙方项目，但由外包流程创建）
 * 4. 契约标记 in_progress，回填 outsourcedTaskId
 *
 * 注：承接任务在乙方项目里（assignee/project 同属乙方），thread 守卫自然通过；
 *     engine.ts 据据 task.outsourcing_contract_id 把 worktree 源 repo 切到甲方 repo、
 *     publish 目标指向甲方 rootDir。
 */
export function createOutsourcedTask(db: DB, contractId: string): { task: ReturnType<typeof getTask>; project: ReturnType<typeof getProject> } {
  const contract = getOutsourcingContract(db, contractId);
  if (contract.state !== 'accepted') {
    throw new AppError(ErrorCode.VALIDATION, `契约 ${contractId} 状态 ${contract.state}，需先 accept`);
  }
  if (!contract.vendorLiaisonAgentId) {
    throw new AppError(ErrorCode.VALIDATION, '契约缺少乙方对接人');
  }
  const now = nowIso();
  // 1. 乙方承接项目：按 source 项目名 + 契约 id 命名，active 态跳过准备流程
  const projectName = `[承接] ${contract.title}`.slice(0, 60);
  const project = createProject(db, {
    companyId: contract.targetCompanyId,
    name: projectName,
    description: `承接 ${contract.sourceCompanyId} 的外包任务：${contract.brief}`,
    firstAgentId: contract.vendorLiaisonAgentId,
    initialState: 'active',
  });
  // 2. 创建承接任务（外包上下文绕过守卫）
  const taskInput: CreateTaskInput = {
    projectId: project.id,
    title: contract.title,
    assigneeAgentId: contract.vendorLiaisonAgentId,
    inputProtocol: {
      type: 'outsourcing',
      sourceCompanyId: contract.sourceCompanyId,
      sourceProjectId: contract.sourceProjectId,
      brief: contract.brief,
      deliverableDir: contract.deliverableDir,
      readonlyRefs: contract.readonlyRefs,
      acceptanceCriteria: contract.acceptanceCriteria,
      revisionRound: contract.revisionRound,
    },
    contextRefs: [`outsourcing_contract:${contract.id}`],
    acceptanceCriteria: contract.acceptanceCriteria,
    outsourcingContext: { contractId, bypassCompanyGuard: true },
  };
  const task = createTask(db, taskInput);
  // 3. 契约标记 in_progress + 回填 outsourcedTaskId
  markInProgress(db, contractId, task.id);
  // 阶段四任务 4.3：与甲方源任务建立 task_dependency（跨公司依赖）。
  // - 源任务执行中（running/claimed）：置 waiting_dependency，交付验收通过后自动唤醒。
  // - 源任务排队中（queued）：仅建依赖——依赖满足后 claimNextTask 自然放行，无需状态变化。
  if (contract.sourceTaskId) {
    try {
      const source = getTask(db, contract.sourceTaskId);
      // Review 修复（H-2）：显式括号——`&&` 优先级高于 `||`，原写法把 running/claimed 拆到了不同分支
      if (source && (source.state === 'running' || source.state === 'claimed')) {
        const now2 = nowIso();
        db.prepare(
          `UPDATE task SET state='waiting_dependency', outcome='waiting_dependency',
            lease_owner_thread_id=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
        ).run(now2, source.id);
        appendTaskEvent(db, source.id, 'waiting_dependency', { reason: 'outsourcing', contractId });
      }
      addDependency(db, contract.sourceTaskId, task.id);
    } catch (e) {
      // 源任务已不存在或状态异常：依赖建立失败不影响外包主流程
      console.warn('outsourcing dependency link failed', { contractId, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return { task: getTask(db, task.id), project: getProject(db, project.id) };
}

/**
 * 返工：验收 changes_requested 后，在乙方承接项目里另起返工任务（继承验收标准）。
 * 复用 business-review 的"返工另起"模式：原承接任务保持 completed/cancelled，新任务继承锚点。
 */
export function createReworkTask(db: DB, contractId: string, feedback: string): ReturnType<typeof getTask> {
  const contract = getOutsourcingContract(db, contractId);
  if (contract.state !== 'in_progress') {
    throw new AppError(ErrorCode.VALIDATION, `契约 ${contractId} 状态 ${contract.state}，返工需在 in_progress`);
  }
  if (!contract.vendorLiaisonAgentId || !contract.outsourcedTaskId) {
    throw new AppError(ErrorCode.VALIDATION, '契约缺少对接人或承接任务');
  }
  const prevTask = getTask(db, contract.outsourcedTaskId);
  const reworkTask = createTask(db, {
    projectId: prevTask.projectId,
    title: `[返工] ${contract.title}`,
    assigneeAgentId: contract.vendorLiaisonAgentId,
    inputProtocol: {
      type: 'outsourcing_rework',
      sourceCompanyId: contract.sourceCompanyId,
      brief: contract.brief,
      deliverableDir: contract.deliverableDir,
      readonlyRefs: contract.readonlyRefs,
      acceptanceCriteria: contract.acceptanceCriteria,
      revisionRound: contract.revisionRound,
      feedback,
      previousTaskId: prevTask.id,
    },
    contextRefs: [`outsourcing_contract:${contract.id}`],
    acceptanceCriteria: contract.acceptanceCriteria, // 返工不丢锚
    outsourcingContext: { contractId, bypassCompanyGuard: true },
  });
  // 直接回填新承接任务 id（契约已在 in_progress，无需再迁态）
  const now = nowIso();
  db.prepare('UPDATE outsourcing_contract SET outsourced_task_id=?, updated_at=? WHERE id=?').run(
    reworkTask.id,
    now,
    contractId,
  );
  return getTask(db, reworkTask.id);
}
