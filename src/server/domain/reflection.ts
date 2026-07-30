/**
 * 双 Loop ① 反思闭环（P3）。
 *
 * 把"task 到达终态 → 离线复盘 → 经验沉淀进 memory → 下次执行更优"这条回路接上。
 * 与 memory.ts 的咬合：memory 这条腿早会走（候选→审批→版本化→FTS→loadContextMemories 注入），
 * 反思这条腿一接上立刻闭合成环——反思产出的 lesson 经 createMemoryCandidate 落库后，
 * 自动被 assembleContext 的 loadContextMemories（context.ts）注入下次 system prompt。
 *
 * 设计原则：
 * - 异步两段式：enqueue 只做快速入队（纯 DB、无 LLM），drain 由 coordinator.tick() 离线消化。
 *   这与 TriggerScheduler / report 周期复盘同构，绝不在 task 收尾路径上调 LLM。
 * - 只写记忆、不派 Task：反思产物只落 memory，避免与 business-review 返工/熔断回流/report 重复
 *   或形成派发回环（天然不进 isDispatchLoop 检测域）。
 * - 与 report.ts 正交：report 是"全公司停摆 + 人工看板 + 人工转修正"的粗粒度周期复盘；
 *   本机制是 per-task 的轻量自动反思。
 * - 复用不重造：经验走 createMemoryCandidate（scope=project），推理走 callLlm，影响回路走 loadContextMemories。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { log } from '../logger';
import { callLlm } from './llm-call';
import { getTask, type Task } from './task';
import { getProject } from './project';
import { getAgent } from './agent';
import { createMemoryCandidate, searchMemory } from './memory';

/** 反思信号来源（兼作根因分类标签，喂给 prompt 与归因分析）。 */
export type ReflectionSignal =
  | 'completed'
  | 'failed'
  | 'blocked-safety'
  | 'rework'
  | 'circuit-break-rollback';

/** 反思状态。 */
export type ReflectionStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export interface TaskReflection {
  id: string;
  taskId: string;
  companyId: string;
  projectId: string;
  profileId: string | null;
  outcome: string;
  signal: ReflectionSignal;
  contextSnapshot: Record<string, unknown>;
  status: ReflectionStatus;
  candidateId: string | null;
  reflectionText: string | null;
  error: string | null;
  createdAt: string;
  reflectedAt: string | null;
}

interface ReflectionRow {
  id: string;
  task_id: string;
  company_id: string;
  project_id: string;
  profile_id: string | null;
  outcome: string;
  signal: string;
  context_snapshot: string;
  status: ReflectionStatus;
  candidate_id: string | null;
  reflection_text: string | null;
  error: string | null;
  created_at: string;
  reflected_at: string | null;
}

function fromRow(r: ReflectionRow): TaskReflection {
  return {
    id: r.id,
    taskId: r.task_id,
    companyId: r.company_id,
    projectId: r.project_id,
    profileId: r.profile_id,
    outcome: r.outcome,
    signal: r.signal as ReflectionSignal,
    contextSnapshot: JSON.parse(r.context_snapshot ?? '{}'),
    status: r.status,
    candidateId: r.candidate_id,
    reflectionText: r.reflection_text,
    error: r.error,
    createdAt: r.created_at,
    reflectedAt: r.reflected_at,
  };
}

export interface EnqueueReflectionInput {
  task: Task;
  outcome: string;
  signal: ReflectionSignal;
  /** 额外上下文（如失败错误、熔断回流前的 phase、安全阻断原因）。 */
  extraContext?: Record<string, unknown>;
}

/**
 * 入队一条反思（快速、纯 DB、无 LLM）。task_id UNIQUE 保证幂等。
 * 在 task 终态点（engine.ts 的 completeTask 后 / handleRunError / 安全阻断旁路）调用。
 */
export function enqueueReflection(db: DB, input: EnqueueReflectionInput): void {
  const { task, outcome, signal, extraContext } = input;
  const project = getProject(db, task.projectId);
  const profileId = task.assigneeAgentId
    ? (getAgent(db, task.assigneeAgentId)?.profileId ?? null)
    : null;
  // 终态最小快照：让反思推理不必回查整条执行链。
  const snapshot: Record<string, unknown> = {
    title: task.title,
    seq: task.seq,
    goal: task.inputProtocol,
    summary: task.summary,
    failureCount: task.failureCount,
    interruptionCount: task.interruptionCount,
    alignmentRounds: task.alignmentRounds,
    acceptanceCriteria: task.acceptanceCriteria,
    ...extraContext,
  };
  const id = shortId('rfl_');
  const now = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO task_reflection
      (id, task_id, company_id, project_id, profile_id, outcome, signal, context_snapshot, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    task.id,
    project.companyId,
    task.projectId,
    profileId,
    outcome,
    signal,
    JSON.stringify(snapshot),
    now,
  );
}

/**
 * 离线消化反思队列。由 coordinator 的独立反思定时器调用（不在 tick 同步路径内，
 * 避免 LLM 慢调用阻塞租约恢复/任务泵送）。
 *
 * 用 UPDATE...RETURNING 做原子领取（pending→running），避免 select-then-update 竞态；
 * 单条失败标记 error，不无限重试（避免坏数据反复占用 LLM 配额）。
 */
export async function drainReflectionQueue(
  db: DB,
  options: { maxPerTick?: number; companyId?: string } = {},
): Promise<{ processed: number; lessons: number }> {
  const maxPerTick = Math.min(Math.max(options.maxPerTick ?? 3, 1), 10);
  // 原子领取：UPDATE...RETURNING 把 pending 翻成 running 并返回被领取的行。
  const claimSql = options.companyId
    ? `UPDATE task_reflection SET status='running' WHERE id IN (
         SELECT id FROM task_reflection WHERE status='pending' AND company_id=?
         ORDER BY created_at LIMIT ?
       ) RETURNING *`
    : `UPDATE task_reflection SET status='running' WHERE id IN (
         SELECT id FROM task_reflection WHERE status='pending'
         ORDER BY created_at LIMIT ?
       ) RETURNING *`;
  const rows = (options.companyId
    ? db.prepare(claimSql).all(options.companyId, maxPerTick)
    : db.prepare(claimSql).all(maxPerTick)) as ReflectionRow[];

  let lessons = 0;
  for (const row of rows) {
    try {
      const reflection = fromRow(row);
      const result = await reflectOnTask(db, reflection);
      if (result === 'done') lessons++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(
        `UPDATE task_reflection SET status='error', error=?, reflected_at=? WHERE id=?`,
      ).run(message.slice(0, 500), nowIso(), row.id);
      log.warn('reflection failed', { reflectionId: row.id, taskId: row.task_id, error: message });
    }
  }
  return { processed: rows.length, lessons };
}

/**
 * 复位卡死的反思记录：进程崩溃/被 kill 会留下 status='running' 但无 reflected_at 的行。
 * 在启动时或定期调用，把它们复位为 pending 重新排队（类比 recoverExpiredLeases）。
 */
export function recoverStuckReflections(db: DB): number {
  const info = db.prepare(
    `UPDATE task_reflection SET status='pending' WHERE status='running' AND reflected_at IS NULL`,
  ).run();
  return info.changes;
}

/**
 * 对单条反思执行推理 + 沉淀。
 * 返回 done（已沉淀）/ skipped（去重命中或无价值）。
 * 注：进入此函数前 drainReflectionQueue 已原子领取并标 running。
 */
async function reflectOnTask(db: DB, reflection: TaskReflection): Promise<'done' | 'skipped'> {
  // 无 profileId（无 assignee）的 task 无法沉淀到任何 profile，直接 skip，不浪费 LLM 调用。
  if (!reflection.profileId) {
    db.prepare(
      `UPDATE task_reflection SET status='skipped', reflection_text='无 profileId 无法沉淀', reflected_at=? WHERE id=?`,
    ).run(nowIso(), reflection.id);
    return 'skipped';
  }

  const task = getTask(db, reflection.taskId);
  // 组装反思 prompt：目标 + 执行 trace + 根因信号（打断/对齐/验收/失败）+ 已有相关记忆去重。
  const signalHint = describeSignal(reflection.signal);
  const snap = reflection.contextSnapshot;
  const acceptanceLine = task.acceptanceCriteria.length
    ? task.acceptanceCriteria
        .map((a) => `- [${a.id}] ${a.criterion}${a.met === undefined ? '' : a.met ? ' (达标)' : ' (未达标)'}`)
        .join('\n')
    : '（未设定验收标准）';

  // 已有相关记忆：用于让 LLM 知道已学到什么、避免重复，并在 prompt 里体现。
  const existing = reflection.profileId
    ? searchMemory(db, {
        profileId: reflection.profileId,
        companyId: reflection.companyId,
        projectId: reflection.projectId,
        query: task.title.slice(0, 40),
        limit: 5,
      })
    : [];
  const existingLine = existing.length
    ? existing.map((m) => `- ${m.content.slice(0, 120)}`).join('\n')
    : '（无）';

  const system =
    '你是一个任务反思助手。从单个任务的执行结果中提炼"对未来同类任务有复用价值"的经验教训。' +
    '只产出具体、可操作、能影响下次执行的经验，不要空泛总结，不要复述任务本身。' +
    '如果这次执行没有值得沉淀的新经验（与已有记忆重复或纯属偶发），直接返回 SKIPPED。';
  const user = [
    `任务：#${task.seq} ${task.title}`,
    `结果信号：${signalHint}`,
    `执行摘要：${task.summary || '（无）'}`,
    `失败次数：${task.failureCount}；中间打断次数：${task.interruptionCount}；开始段对齐轮次：${task.alignmentRounds}`,
    `验收标准：\n${acceptanceLine}`,
    `已有相关经验：\n${existingLine}`,
    '',
    '请输出一条经验教训（50-150 字），聚焦"下次如何做得更好/如何避免本次问题"。',
    '若经验与已有记忆高度重复或无复用价值，返回：SKIPPED',
    '格式：先单行写置信度（0-1 的小数，如 0.8），下一行写经验正文。',
  ].join('\n');

  const llm = await callLlm(db, { system, user, companyId: reflection.companyId, timeoutMs: 45_000 });
  const text = llm.content.trim();

  // SKIPPED：去重或无价值
  if (/^SKIPPED/i.test(text)) {
    db.prepare(
      `UPDATE task_reflection SET status='skipped', reflection_text=?, reflected_at=? WHERE id=?`,
    ).run(text.slice(0, 500), nowIso(), reflection.id);
    return 'skipped';
  }

  // 解析：首行置信度，其余为正文
  const lines = text.split('\n').filter((l) => l.trim());
  let confidence = 0.7;
  let body = text;
  if (lines.length >= 2) {
    const firstNum = parseFloat(lines[0]!);
    if (!Number.isNaN(firstNum) && firstNum >= 0 && firstNum <= 1) {
      confidence = firstNum;
      body = lines.slice(1).join('\n').trim();
    }
  }
  body = body.slice(0, 500);
  if (!body) {
    db.prepare(
      `UPDATE task_reflection SET status='skipped', reflection_text='空正文', reflected_at=? WHERE id=?`,
    ).run(nowIso(), reflection.id);
    return 'skipped';
  }

  // 沉淀为 memory candidate。scope=project（与 flushThreadMemory 一致，auto-approvable，影响面可控）。
  // 高置信（>=0.8）才自动批准生效；低置信进 pending 待用户审（不自动影响未来操作）。
  const candidate = createMemoryCandidate(db, {
    profileId: reflection.profileId,
    scope: 'project',
    companyId: reflection.companyId,
    projectId: reflection.projectId,
    content: body,
    sourceTaskId: reflection.taskId,
    author: 'agent',
    confidence,
    canInfluence: true,
    allowAutoApprove: confidence >= 0.8,
  });

  db.prepare(
    `UPDATE task_reflection SET status='done', candidate_id=?, reflection_text=?, reflected_at=? WHERE id=?`,
  ).run(candidate.id, body, nowIso(), reflection.id);
  return 'done';
}

function describeSignal(signal: ReflectionSignal): string {
  switch (signal) {
    case 'completed': return '顺利完成';
    case 'failed': return '执行失败';
    case 'blocked-safety': return '被安全检查阻断';
    case 'rework': return '验收未过，被打回返工';
    case 'circuit-break-rollback': return '连续失败触发熔断，项目回流到准备阶段';
    default: return signal;
  }
}
