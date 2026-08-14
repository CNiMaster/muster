/**
 * 蜂群领域层（指挥系统批次2，spec 2026-08-14-command-system-design）。
 *
 * 结构：树管控制面（parent_task_id + swarm_id/swarm_depth 算深度/宽度/总量/预算账），
 * 依赖管执行面（task_dependency + waiting_dependency 收口，复用现有机制）。
 *
 * 失败可观测（用户核心关切）：单一记账咽喉——蜂任务终态统一过
 * recordSwarmNodeOutcome（completeTask/failTask/cancelTask 调用），
 * 更新整群计数；失败率过线 → 去重「蜂群告警」给调度中心；失败过半 → 自动熔断。
 * 蜂群内失败不走 [兜底]（那会打扰第一负责人），改道调度中心处置。
 *
 * 注：与 task.ts / temp-worker.ts 存在循环导入——ESM 函数级调用安全（不在模块加载期互相求值）。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';
import { getSystemSettings } from './setting';
import { addTaskMessage } from './task-message';
import { appendTaskEvent } from './task-event';
import { addDependency, cancelTask, createTask, getTask, type Task } from './task';
import { createTempEmployment, dismissTempWorker, markTempGreyed } from './temp-worker';
import { ensurePrimaryThread } from './thread';
import type { SwarmPlan } from '../../shared/types';

export const SWARM_WORKER_ROLE = 'swarm-worker';

export interface SwarmLimits {
  maxDepth: number;
  maxWidth: number;
  maxNodes: number;
  budgetUsd: number;
}

/** 从系统设置读限额（上限非目标——分解多少由调度中心按需决定，这里只做熔断）。 */
export function getSwarmLimits(db: DB): SwarmLimits {
  const s = getSystemSettings(db);
  return { maxDepth: s.swarmMaxDepth, maxWidth: s.swarmMaxWidth, maxNodes: s.swarmMaxNodes, budgetUsd: s.swarmBudgetUSD };
}

export interface SwarmRun {
  id: string;
  companyId: string;
  projectId: string;
  rootTaskId: string;
  synthesisTaskId: string | null;
  goal: string;
  status: 'active' | 'completed' | 'aborted' | 'failed';
  maxDepth: number;
  maxWidth: number;
  maxNodes: number;
  budgetUsd: number;
  nodesTotal: number;
  nodesDone: number;
  nodesFailed: number;
  createdAt: string;
  finishedAt: string | null;
}

interface SwarmRunRow {
  id: string;
  company_id: string;
  project_id: string;
  root_task_id: string;
  synthesis_task_id: string | null;
  goal: string;
  status: SwarmRun['status'];
  max_depth: number;
  max_width: number;
  max_nodes: number;
  budget_usd: number;
  nodes_total: number;
  nodes_done: number;
  nodes_failed: number;
  created_at: string;
  finished_at: string | null;
}

function swarmFromRow(r: SwarmRunRow): SwarmRun {
  return {
    id: r.id,
    companyId: r.company_id,
    projectId: r.project_id,
    rootTaskId: r.root_task_id,
    synthesisTaskId: r.synthesis_task_id,
    goal: r.goal,
    status: r.status,
    maxDepth: r.max_depth,
    maxWidth: r.max_width,
    maxNodes: r.max_nodes,
    budgetUsd: r.budget_usd,
    nodesTotal: r.nodes_total,
    nodesDone: r.nodes_done,
    nodesFailed: r.nodes_failed,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export function getSwarmRun(db: DB, id: string): SwarmRun {
  const row = db.prepare('SELECT * FROM swarm_run WHERE id=?').get(id) as SwarmRunRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `swarm ${id} not found`);
  return swarmFromRow(row);
}

/** 建群：限额在创建时从系统设置定格为快照（群内不再随设置变化漂移）。 */
export function createSwarmRun(db: DB, input: { companyId: string; projectId: string; rootTaskId: string; goal: string }): SwarmRun {
  const limits = getSwarmLimits(db);
  const id = shortId('sw_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO swarm_run (id, company_id, project_id, root_task_id, goal, status, max_depth, max_width, max_nodes, budget_usd, created_at)
     VALUES (?,?,?,?,?,'active',?,?,?,?,?)`,
  ).run(id, input.companyId, input.projectId, input.rootTaskId, input.goal, limits.maxDepth, limits.maxWidth, limits.maxNodes, limits.budgetUsd, now);
  return getSwarmRun(db, id);
}

/** 实时节点统计（根调度任务不计；cancelled 计入 done=已收口）。 */
export function countSwarmNodes(db: DB, swarmId: string): { total: number; done: number; failed: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN state IN ('completed','cancelled') THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM task WHERE swarm_id = ? AND id != (SELECT root_task_id FROM swarm_run WHERE id = ?)`,
    )
    .get(swarmId, swarmId) as { total: number; done: number | null; failed: number | null };
  return { total: row.total, done: row.done ?? 0, failed: row.failed ?? 0 };
}

/** 整群已花费（USD）：usage_record 按任务归属聚合。 */
export function swarmSpendUsd(db: DB, swarmId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(u.cost_usd), 0) AS c
       FROM usage_record u JOIN task t ON t.id = u.task_id
       WHERE t.swarm_id = ?`,
    )
    .get(swarmId) as { c: number };
  return row.c;
}

export type SwarmGuardResult = { ok: true } | { ok: false; reason: string };

/**
 * 四项限额检查（深度/宽度/总量/预算）。parentTaskId 给出时按"从该节点再下探一层"判定。
 * 预算 0 = 不限。
 */
export function checkSwarmLimits(
  db: DB,
  swarmId: string,
  opts: { parentTaskId?: string; addCount?: number },
): SwarmGuardResult {
  const swarm = getSwarmRun(db, swarmId);
  if (swarm.status !== 'active') {
    return { ok: false, reason: `蜂群已${statusLabel(swarm.status)}，不再接收新蜂` };
  }
  const addCount = opts.addCount ?? 1;
  if (opts.parentTaskId) {
    const parent = getTask(db, opts.parentTaskId);
    const childDepth = parent.swarmDepth + 1;
    if (childDepth > swarm.maxDepth) {
      return { ok: false, reason: `已达最大深度 ${swarm.maxDepth} 层，不能再下探（当前 ${parent.swarmDepth} 层）` };
    }
    const siblings = db
      .prepare('SELECT COUNT(*) AS c FROM task WHERE swarm_id=? AND parent_task_id=?')
      .get(swarmId, opts.parentTaskId) as { c: number };
    if (siblings.c + addCount > swarm.maxWidth) {
      return { ok: false, reason: `该节点扇出已达上限 ${swarm.maxWidth}（现有 ${siblings.c}）` };
    }
  }
  const nodes = countSwarmNodes(db, swarmId);
  if (nodes.total + addCount > swarm.maxNodes) {
    return { ok: false, reason: `蜂群总节点已达上限 ${swarm.maxNodes}（现有 ${nodes.total}）` };
  }
  if (swarm.budgetUsd > 0 && swarmSpendUsd(db, swarmId) >= swarm.budgetUsd) {
    return { ok: false, reason: `蜂群预算已用尽（上限 $${swarm.budgetUsd}）` };
  }
  return { ok: true };
}

function statusLabel(status: SwarmRun['status']): string {
  return status === 'aborted' ? '终止' : status === 'failed' ? '熔断' : '收口';
}

// ===== 记账咽喉 =====

/**
 * 蜂任务终态记账（completeTask/failTask/cancelTask 调用）：
 * 1. 更新整群计数（failed 同时计入 done=已收口；根调度任务不计）。
 * 2. 失败率 ≥30%（≥3 个已收口节点）→ 去重「蜂群告警」给调度中心。
 * 3. 失败 >50% → 自动熔断（取消剩余 + status=failed + 终局摘要）。
 * 4. 全部收口 → 关群 + 清理工蜂。
 */
export function recordSwarmNodeOutcome(db: DB, task: Task, kind: 'done' | 'failed' | 'cancelled'): void {
  const swarmId = task.swarmId;
  if (!swarmId) return;
  const swarm = getSwarmRun(db, swarmId);
  if (task.id === swarm.rootTaskId) return; // 根调度任务不计入节点
  // 只记"计数节点"（蜂 depth≥1 / 汇总任务）；[蜂群告警] 等辅助任务不占 nodes_total
  const counted = task.swarmDepth >= 1 || (task.inputProtocol as Record<string, unknown>)?.swarmNode === true;
  if (!counted) return;

  if (kind === 'failed') {
    db.prepare('UPDATE swarm_run SET nodes_failed = nodes_failed + 1, nodes_done = nodes_done + 1 WHERE id=?').run(swarmId);
  } else {
    db.prepare('UPDATE swarm_run SET nodes_done = nodes_done + 1 WHERE id=?').run(swarmId);
  }

  const fresh = getSwarmRun(db, swarmId);
  if (fresh.status === 'active' && fresh.nodesTotal > 0 && fresh.nodesDone >= fresh.nodesTotal) {
    closeSwarm(db, swarmId);
    return;
  }
  if (fresh.status === 'active' && kind === 'failed') {
    maybeSwarmAlert(db, swarmId, task);
    maybeCircuitBreak(db, swarmId);
  }
}

/** 失败率 ≥30%（至少 3 个已收口节点且至少 1 个失败）→ 去重「蜂群告警」给调度中心。 */
function maybeSwarmAlert(db: DB, swarmId: string, failedTask: Task): void {
  const swarm = getSwarmRun(db, swarmId);
  if (swarm.nodesDone < 3) return;
  if (swarm.nodesFailed / swarm.nodesDone < 0.3) return;

  // 去重：群内已有未完成的 [蜂群告警] 任务则只追加失败信息，不重复派发
  const existing = db
    .prepare(
      `SELECT id, input_protocol_json FROM task
       WHERE swarm_id=? AND title LIKE '[蜂群告警]%' AND state NOT IN ('completed','cancelled','failed')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(swarmId) as { id: string; input_protocol_json: string } | undefined;
  const failureNote = {
    failedTaskId: failedTask.id,
    failedTaskSeq: failedTask.seq,
    failedTaskTitle: failedTask.title,
    failureMessage: (failedTask.summary ?? '').slice(0, 500),
    at: nowIso(),
  };
  if (existing) {
    try {
      const proto = JSON.parse(existing.input_protocol_json ?? '{}') as Record<string, unknown>;
      const failures = Array.isArray(proto.failures) ? proto.failures as unknown[] : [];
      failures.push(failureNote);
      db.prepare('UPDATE task SET input_protocol_json=?, updated_at=? WHERE id=?')
        .run(JSON.stringify({ ...proto, failures, counts: { settled: swarm.nodesDone, failed: swarm.nodesFailed } }), nowIso(), existing.id);
    } catch {
      // 追加失败不阻塞主流程
    }
    return;
  }

  const root = db
    .prepare('SELECT assignee_agent_id AS id FROM task WHERE id=?')
    .get(swarm.rootTaskId) as { id: string | null } | undefined;
  if (!root?.id) return;
  createTask(db, {
    projectId: swarm.projectId,
    parentTaskId: swarm.rootTaskId,
    rootTaskId: swarm.rootTaskId,
    assigneeAgentId: root.id,
    dispatcherAgentId: root.id,
    title: '[蜂群告警] 失败率过线，请处置',
    inputProtocol: {
      reason: 'swarm_alert',
      swarmId,
      goal: swarm.goal,
      counts: { settled: swarm.nodesDone, failed: swarm.nodesFailed, total: swarm.nodesTotal },
      failures: [failureNote],
      guidance:
        '处置选项：a) 补蜂（返回 swarmPlan，只含需补做的子题）；b) 缩群收口（直接完成汇报）；c) 放弃（blocked + 原因）。',
    },
    priority: 8,
    skipLaunchGate: true,
    swarmId,
    swarmDepth: 0,
  });
  appendTaskEvent(db, swarm.rootTaskId, 'swarm_alert', { swarmId, failed: swarm.nodesFailed, settled: swarm.nodesDone });
}

/** 失败 >50%（≥2 个已收口）→ 自动熔断：取消剩余蜂、status=failed、终局摘要给调度中心。 */
function maybeCircuitBreak(db: DB, swarmId: string): void {
  const swarm = getSwarmRun(db, swarmId);
  if (swarm.status !== 'active' || swarm.nodesDone < 2) return;
  if (swarm.nodesFailed / swarm.nodesDone <= 0.5) return;
  abortSwarm(db, swarmId, {
    reason: `蜂群熔断：${swarm.nodesFailed}/${swarm.nodesDone} 个已收口节点失败（>50%）`,
    status: 'failed',
    includeRoot: false,
  });
}

/**
 * 终止蜂群：取消剩余节点 + 关群 + 清理工蜂。
 * - 用户停群：includeRoot=true（连根调度任务一起取消，一切停止）
 * - 自动熔断：includeRoot=false（保留根任务，让其恢复后产出终局报告）
 */
export function abortSwarm(db: DB, swarmId: string, opts: { reason: string; status: 'aborted' | 'failed'; includeRoot: boolean }): void {
  const swarm = getSwarmRun(db, swarmId);
  if (swarm.status !== 'active') return;
  const actives = db
    .prepare(
      `SELECT id FROM task
       WHERE swarm_id=? AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','paused','blocked')`,
    )
    .all(swarmId) as Array<{ id: string }>;
  for (const t of actives) {
    if (!opts.includeRoot && t.id === swarm.rootTaskId) continue;
    try {
      cancelTask(db, t.id);
    } catch {
      // 状态竞争时跳过（可能刚好被领取/完成）
    }
  }
  db.prepare('UPDATE swarm_run SET status=?, finished_at=? WHERE id=?').run(opts.status, nowIso(), swarmId);
  appendTaskEvent(db, swarm.rootTaskId, opts.status === 'aborted' ? 'swarm_aborted' : 'swarm_circuit_broken', { swarmId, reason: opts.reason });
  addTaskMessage(db, swarm.rootTaskId, {
    author: 'system',
    role: 'dispatch',
    content: `[蜂群终止] ${opts.reason}。剩余节点已取消，工蜂已回收。`,
  });
  releaseSwarmBees(db, swarmId);
}

/** 关群（全部收口）：清理工蜂；失败明细留在任务树与事件里。 */
function closeSwarm(db: DB, swarmId: string): void {
  const swarm = getSwarmRun(db, swarmId);
  db.prepare('UPDATE swarm_run SET status=?, finished_at=? WHERE id=?').run('completed', nowIso(), swarmId);
  appendTaskEvent(db, swarm.rootTaskId, 'swarm_closed', { swarmId, failed: swarm.nodesFailed });
  addTaskMessage(db, swarm.rootTaskId, {
    author: 'system',
    role: 'dispatch',
    content: `[蜂群收口] 全部 ${swarm.nodesTotal} 个节点完成（失败 ${swarm.nodesFailed} 个）。`,
  });
  releaseSwarmBees(db, swarmId);
}

/**
 * 回收工蜂：dismiss 是硬删（is_temp_only=1 连 profile + Agent Home 清理）——
 * 审计保留在 task 行（标题/状态/摘要）与 task_event，不依赖 agent 行存在。
 */
export function releaseSwarmBees(db: DB, swarmId: string): void {
  const beeIds = db
    .prepare(
      `SELECT DISTINCT t.assignee_agent_id AS id FROM task t
       JOIN agent_definition a ON a.id = t.assignee_agent_id
       WHERE t.swarm_id=? AND a.role=? AND a.is_system=0`,
    )
    .all(swarmId, SWARM_WORKER_ROLE) as Array<{ id: string }>;
  for (const bee of beeIds) {
    if (!bee.id) continue;
    try {
      dismissTempWorker(db, bee.id, { confirm: true });
    } catch {
      // 竞态或已删时降级为灰色保留
      try {
        markTempGreyed(db, bee.id);
      } catch {
        // 记录已不存在时忽略
      }
    }
  }
}

/** 蜂任务终态时把蜂灰化（蜂不再领新活；彻底回收等群关闭统一做）。 */
export function greyBeeAfterTask(db: DB, task: Task): void {
  if (!task.swarmId || !task.assigneeAgentId) return;
  const isBee = db
    .prepare('SELECT 1 AS ok FROM agent_definition WHERE id=? AND role=?')
    .get(task.assigneeAgentId, SWARM_WORKER_ROLE) as { ok: number } | undefined;
  if (!isBee) return;
  try {
    markTempGreyed(db, task.assigneeAgentId);
  } catch {
    // 忽略：蜂记录异常不影响任务收口
  }
}

/**
 * 蜂失败后的依赖解除：把"仅剩失败依赖阻塞"的等待方恢复为 queued（失败视为已收口）。
 * 现有 areDependenciesMet 把 failed 视为阻塞（靠 60 分钟超时上报兜底）——
 * 蜂群不能等超时：失败是信息不是死锁，调度/汇总要带着失败继续走。
 */
export function resumeSwarmDependentsAfterFailure(db: DB, failedTaskId: string): string[] {
  const now = nowIso();
  const dependents = db
    .prepare(
      `SELECT d.task_id FROM task_dependency d
       JOIN task t ON t.id = d.task_id
       WHERE d.depends_on_id = ? AND t.state = 'waiting_dependency'`,
    )
    .all(failedTaskId) as { task_id: string }[];
  const resumed: string[] = [];
  for (const dep of dependents) {
    // 剩余阻塞里是否还有非 failed 的（completed/cancelled/failed 都算已处理）
    const blocked = db
      .prepare(
        `SELECT EXISTS(
          SELECT 1 FROM task_dependency d JOIN task t ON t.id = d.depends_on_id
          WHERE d.task_id = ? AND t.state NOT IN ('completed','cancelled','failed')) AS b`,
      )
      .get(dep.task_id) as { b: number };
    if (blocked.b === 0) {
      db.prepare(`UPDATE task SET state='queued', updated_at=? WHERE id=? AND state='waiting_dependency'`).run(now, dep.task_id);
      appendTaskEvent(db, dep.task_id, 'resumed', { from: 'waiting_dependency', triggeredBy: failedTaskId, note: 'swarm_failed_member_treated_as_settled' });
      resumed.push(dep.task_id);
    }
  }
  return resumed;
}

/**
 * 蜂群失败处置（failTask 对 swarm 任务的替代传播——不走 [兜底]/第一负责人）：
 * 1. 给根任务写失败通知（调度中心下次执行/告警处置可见）。
 * 2. 失败视为已收口，恢复被阻塞的等待方（汇总任务/父蜂继续走）。
 * 3. 记账（计数 + 告警评估 + 熔断评估）。
 */
export function handleSwarmTaskFailure(db: DB, failedTask: Task, message: string): void {
  const swarmId = failedTask.swarmId;
  if (!swarmId) return;
  const swarm = getSwarmRun(db, swarmId);
  addTaskMessage(db, swarm.rootTaskId, {
    author: failedTask.assigneeAgentId ?? 'system',
    role: 'dispatch',
    content: `[蜂成员失败] Task #${failedTask.seq}「${failedTask.title}」：${message.slice(0, 300)}`,
  });
  resumeSwarmDependentsAfterFailure(db, failedTask.id);
  greyBeeAfterTask(db, failedTask);
  recordSwarmNodeOutcome(db, failedTask, 'failed');
}

/** 蜂任务完成：结构化摘要写进群汇总任务（汇总执行的上下文来源；汇总已终态则写根任务留档）。 */
export function reportBeeCompletion(db: DB, beeTask: Task): void {
  const swarmId = beeTask.swarmId;
  if (!swarmId) return;
  const swarm = getSwarmRun(db, swarmId);
  // 根调度任务/汇总任务自身的完成不写汇报消息（否则写给自己）
  if (beeTask.id === swarm.rootTaskId || beeTask.id === swarm.synthesisTaskId) return;
  const summaryText = (beeTask.summary ?? '').slice(0, 800);
  let targetId: string | null = swarm.synthesisTaskId;
  if (targetId) {
    const synthesis = db.prepare('SELECT state FROM task WHERE id=?').get(targetId) as { state: string } | undefined;
    if (!synthesis || ['completed', 'cancelled', 'failed'].includes(synthesis.state)) {
      targetId = swarm.rootTaskId; // 汇总已收口（补蜂场景）→ 写根任务留档
    }
  } else {
    targetId = swarm.rootTaskId;
  }
  if (!targetId) return;
  addTaskMessage(db, targetId, {
    author: beeTask.assigneeAgentId ?? 'system',
    role: 'dispatch',
    content: `[蜂成员汇报] Task #${beeTask.seq}「${beeTask.title}」：${summaryText}`,
  });
}

// ===== 工蜂与放蜂（W2/W3） =====

const BEE_PROMPT = `你是蜂群工蜂：一次性任务执行者，为"调度中心"工作。
- 只做当前任务 inputPacket.swarm.brief 描述的事，不扩大范围。
- 完成时必须返回结构化摘要：结论（一段话）+ 证据（要点列表，每条注明来源）+ 风险/信息缺失（如适用），总长不超过 500 字。
- 如子题仍太大确需细分，可通过 done 的 outboundTasks 下派子任务（recipientAgentId 填新工蜂不可行——你没有创建权；填同事或留空交回调度），
  保持最小拆分：系统有深度/数量/预算上限，超限会被拦截并留 swarm_limit_blocked 事件。`;

/**
 * 创建一次性工蜂（临时工基建 + hidden + 独立 primary 线程）。
 * 干净上下文、跑完即焚（群关闭统一 dismiss）、不进花名册、不写员工记忆。
 */
export function createWorkerBee(
  db: DB,
  input: { companyId: string; projectId: string; requesterAgentId: string; index: number },
): string {
  const { agentId } = createTempEmployment(db, {
    companyId: input.companyId,
    role: SWARM_WORKER_ROLE,
    requesterAgentId: input.requesterAgentId,
    name: `工蜂-${input.index + 1}`,
    systemPrompt: BEE_PROMPT,
  });
  db.prepare('UPDATE company_employee SET hidden=1 WHERE legacy_agent_id=?').run(agentId);
  ensurePrimaryThread(db, input.projectId, agentId);
  return agentId;
}

export interface MaterializedSwarm {
  swarmId: string;
  beeTaskIds: string[];
  synthesisTaskId: string | null;
  /** 超过扇出上限被截断时为 true（截断明细在 swarm_plan_truncated 事件里）。 */
  truncated: boolean;
}

/**
 * 蜂群落地（引擎在调度中心返回 swarmPlan 后调用）：
 * - 新群：swarm_run + 逐蜂建 agent+任务（depth=1）+ 独立汇总任务（depth=0，依赖全部蜂）
 *   + 根调度任务依赖汇总（waiting_dependency 收口）。
 * - 补蜂（sourceTask.inputProtocol.swarmId 指向活跃群，如 [蜂群告警] 处置）：不建新群不建新汇总，
 *   追加蜂到原群（nodes_total += N），汇报写入原汇总/根任务。
 * 扇出超上限：截断到上限并留事件（不硬失败——调度中心的反馈通道已关闭，截断优于丢弃）。
 */
export function materializeSwarm(db: DB, sourceTask: Task, plan: SwarmPlan): MaterializedSwarm {
  if (!plan.workers?.length) {
    throw new AppError(ErrorCode.VALIDATION, 'swarmPlan.workers 至少 1 个工蜂任务');
  }
  const rootDispatcherId = sourceTask.assigneeAgentId ?? sourceTask.dispatcherAgentId;
  if (!rootDispatcherId) {
    throw new AppError(ErrorCode.VALIDATION, '调度任务缺少执行者，无法放蜂');
  }
  const limits = getSwarmLimits(db);
  const proto = sourceTask.inputProtocol as Record<string, unknown>;
  const appendSwarmId = typeof proto.swarmId === 'string' ? proto.swarmId : null;

  // 总量检查：新群 = 蜂 + 汇总；蜂数上限 = maxNodes - 1（给汇总留一个名额）
  const workerCap = Math.min(limits.maxWidth, appendSwarmId ? limits.maxNodes : limits.maxNodes - 1);
  if (!appendSwarmId && workerCap < 1) {
    throw new AppError(ErrorCode.VALIDATION, `蜂群总节点上限 ${limits.maxNodes} 过低（至少 1 蜂 + 1 汇总）`);
  }
  let truncated = false;
  let workers = plan.workers;
  if (workers.length > workerCap) {
    truncated = true;
    workers = workers.slice(0, Math.max(1, workerCap));
  }

  const beeTaskIds: string[] = [];
  const rootTaskId = sourceTask.rootTaskId ?? sourceTask.id;
  let swarm: SwarmRun;

  if (appendSwarmId) {
    // 补蜂：追加到活跃群
    swarm = getSwarmRun(db, appendSwarmId);
    if (swarm.status !== 'active') {
      throw new AppError(ErrorCode.CONFLICT, `蜂群已${statusLabel(swarm.status)}，无法补蜂`);
    }
    const guard = checkSwarmLimits(db, swarm.id, { parentTaskId: sourceTask.id, addCount: workers.length });
    if (!guard.ok) {
      throw new AppError(ErrorCode.CONFLICT, guard.reason);
    }
  } else {
    swarm = createSwarmRun(db, {
      companyId: (db.prepare('SELECT company_id AS id FROM project WHERE id=?').get(sourceTask.projectId) as { id: string }).id,
      projectId: sourceTask.projectId,
      rootTaskId: sourceTask.id,
      goal: plan.goal || sourceTask.title,
    });
  }
  const swarmId = swarm.id;

  for (const [index, worker] of workers.entries()) {
    const beeAgentId = createWorkerBee(db, {
      companyId: swarm.companyId,
      projectId: swarm.projectId,
      requesterAgentId: rootDispatcherId,
      index,
    });
    const beeTask = createTask(db, {
      projectId: swarm.projectId,
      parentTaskId: sourceTask.id,
      rootTaskId,
      dispatcherAgentId: rootDispatcherId,
      assigneeAgentId: beeAgentId,
      title: worker.title,
      inputProtocol: {
        trigger: 'swarm_bee',
        swarm: { swarmId, goal: swarm.goal, brief: worker.brief, depth: 1 },
        swarmNode: true,
      },
      priority: 5,
      skipLaunchGate: true,
      swarmId,
      swarmDepth: 1,
    });
    beeTaskIds.push(beeTask.id);
    appendTaskEvent(db, sourceTask.id, 'spawned_child', {
      childId: beeTask.id,
      childSeq: beeTask.seq,
      childTitle: worker.title,
      recipient: beeAgentId,
      dispatcher: rootDispatcherId,
    });
  }

  let synthesisTaskId: string | null = null;
  if (!appendSwarmId) {
    // 新群：独立汇总任务（干净上下文聚合各蜂结构化摘要，父任务上下文可能已满）
    const synthesis = createTask(db, {
      projectId: swarm.projectId,
      parentTaskId: sourceTask.id,
      rootTaskId,
      dispatcherAgentId: rootDispatcherId,
      assigneeAgentId: rootDispatcherId,
      title: `[蜂群汇总] ${plan.goal.slice(0, 40)}`,
      inputProtocol: {
        trigger: 'swarm_synthesis',
        swarm: { swarmId, goal: swarm.goal, beeCount: beeTaskIds.length },
        swarmSynthesis: true,
        swarmNode: true,
      },
      priority: 6,
      skipLaunchGate: true,
      swarmId,
      swarmDepth: 0,
    });
    synthesisTaskId = synthesis.id;
    for (const beeTaskId of beeTaskIds) {
      addDependency(db, synthesisTaskId, beeTaskId);
    }
    addDependency(db, sourceTask.id, synthesisTaskId);
    db.prepare('UPDATE swarm_run SET synthesis_task_id=?, nodes_total=? WHERE id=?')
      .run(synthesisTaskId, beeTaskIds.length + 1, swarmId);
    // 根调度任务挂群（depth=0）：树视图/停群扫描按 swarm_id 找全树
    db.prepare('UPDATE task SET swarm_id=?, swarm_depth=0 WHERE id=?').run(swarmId, sourceTask.id);
    appendTaskEvent(db, sourceTask.id, 'swarm_created', {
      swarmId,
      goal: swarm.goal,
      beeCount: beeTaskIds.length,
      synthesisTaskId,
      truncated,
    });
  } else {
    db.prepare('UPDATE swarm_run SET nodes_total = nodes_total + ? WHERE id=?').run(beeTaskIds.length, swarmId);
    appendTaskEvent(db, sourceTask.id, 'swarm_bees_appended', { swarmId, added: beeTaskIds.length, truncated });
  }
  if (truncated) {
    appendTaskEvent(db, sourceTask.id, 'swarm_plan_truncated', {
      planned: plan.workers.length,
      taken: workers.length,
      reason: `超出扇出上限 ${limits.maxWidth}`,
    });
  }
  return { swarmId, beeTaskIds, synthesisTaskId, truncated };
}
