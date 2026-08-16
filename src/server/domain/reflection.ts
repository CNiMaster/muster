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
import { getPersona } from './persona-library';
import { evolveBlueprint } from './blueprint';

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
 * E4.3 空闲自主反思（白日梦，默认关闭）：公司空闲时对近期终态（completed/failed）但
 * 从未反思过的任务补排队反思。task_reflection UNIQUE(task_id) + NOT EXISTS 保证幂等；
 * cancelled（被返工取消的原 task 已由 rework 反思覆盖）与未终态任务跳过。
 * 返回本次入队数（0 = 没有可反思的任务）。
 */
export function enqueueIdleReflections(db: DB, companyId: string, limit = 2): number {
  const rows = db
    .prepare(
      `SELECT t.id, t.state FROM task t
       WHERE t.project_id IN (SELECT id FROM project WHERE company_id=?)
         AND t.state IN ('completed','failed')
         AND t.is_discussion = 0
         AND NOT EXISTS (SELECT 1 FROM task_reflection tr WHERE tr.task_id = t.id)
       ORDER BY t.updated_at DESC LIMIT ?`,
    )
    .all(companyId, limit) as Array<{ id: string; state: string }>;
  let enqueued = 0;
  for (const row of rows) {
    enqueueReflection(db, {
      task: getTask(db, row.id),
      outcome: row.state,
      signal: row.state === 'failed' ? 'failed' : 'completed',
      extraContext: { idleReflection: true },
    });
    enqueued++;
  }
  return enqueued;
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
  // 蓝图组织批次3：反思消化后进化蓝图——按 (任务类型, 人设) 记账胜负、聚类合并（自动复盘的写入侧）。
  // 不依赖 LLM 反思是否产出记忆：凡入队的终态任务（含 skipped）都计战绩；失败不阻断反思主流程。
  for (const row of rows) {
    try {
      const task = getTask(db, row.task_id);
      if (!task.personaId) continue;
      const persona = getPersona(task.personaId);
      evolveBlueprint(db, {
        companyId: row.company_id,
        projectId: task.projectId,
        taskTitle: task.title,
        personaId: task.personaId,
        personaName: persona?.name ?? task.personaId,
        win: row.outcome === 'completed',
      });
    } catch (err) {
      log.warn('blueprint evolution failed', {
        taskId: row.task_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // E2.2 drain 完成后检测晋升：仅在本轮处理了反思时才扫，避免每 10s 空跑全表 + UPSERT 写放大。
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
 *
 * 单轮 LLM 产两类沉淀（避免双倍调用成本）：
 * - LESSON：单任务经验（"下次同类任务怎么做更好"）。
 * - RULE：协作规则（"涉及他人/其他岗位协同时应遵循的约定"）。这是 ontology 的薄形态——
 *   不独立成模块，融进反思作为产出物，沉淀进 project memory，下次执行自动注入，让协作有共识。
 *   允许只有 LESSON 没有 RULE（反之亦然）；两者都 SKIPPED 才算整条反思 skipped。
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

  // 蓝图组织批次1：任务穿戴了人设时，追加 CRAFT 输出段（方法论挂到人设键上跨任务复用）。
  const persona = task.personaId ? getPersona(task.personaId) : null;
  const personaName = persona?.name ?? task.personaId;

  const system =
    '你是一个任务反思助手。从单个任务的执行结果中提炼沉淀：经验教训（LESSON）、协作规则（RULE），以及（仅当用户反馈含明确偏好信号时）用户偏好（PREFERENCE）。' +
    'LESSON 聚焦"下次同类任务怎么做更好"的单任务经验；' +
    'RULE 聚焦"涉及他人或其他岗位协同时应遵循的约定"（如交付前通知测试、加急任务在标题标注等）。' +
    'PREFERENCE 聚焦"用户明确表达过的个人偏好或忌讳"（如风格、语气、格式、内容、流程倾向），必须是用户视角的喜好陈述，不要把单次请求泛化为通用偏好；' +
    'PREFERENCE 正文必须以【domain】开头，domain ∈ 风格/语气/格式/内容/流程。' +
    (persona
      ? 'CRAFT（仅本次任务穿戴了专家人设时输出）聚焦"以该人设做这类任务的可复用方法论"——以后任何人穿戴同一人设做同类任务都适用的方法（如"写 PRD 先核对数据口径"）；只写方法，不写本项目的具体事实（那些归 LESSON）。'
      : '') +
    'E2.1 每条沉淀附带一个 fingerprint 标签（形如 "domain:topic"，例如 design:color、workflow:handoff、style:business、tone:formal），紧跟置信度行后单独一行，用于后续识别跨任务的重复模式；无明确归类时该行可省略。' +
    '只产出具体、可操作、能影响下次执行的内容，不要空泛总结，不要复述任务本身。' +
    '如果某一类没有值得沉淀的新内容（与已有记忆重复或纯属偶发，或用户反馈中无明显偏好信号），那一类写 SKIPPED。';
  // E1.2 收集用户反馈原文；无反馈时不强求 PREFERENCE（prompt 要求 LLM 写 SKIPPED）。
  const feedbackText = collectUserFeedback(db, reflection.taskId);
  const user = [
    `任务：#${task.seq} ${task.title}`,
    task.personaId ? `执行人设：${personaName}（${task.personaId}）` : '',
    `结果信号：${signalHint}`,
    `执行摘要：${task.summary || '（无）'}`,
    `失败次数：${task.failureCount}；中间打断次数：${task.interruptionCount}；开始段对齐轮次：${task.alignmentRounds}`,
    `验收标准：\n${acceptanceLine}`,
    feedbackText ? `用户反馈（可用于提炼偏好）：\n${feedbackText}` : '用户反馈：（无显式反馈）',
    `已有相关经验：\n${existingLine}`,
    '',
    '请按以下格式输出（各类都可省略，没有价值的写 SKIPPED；无用户反馈时 PREFERENCE 必须 SKIPPED）：',
    '[LESSON]',
    '<置信度 0-1 的小数>',
    '<fingerprint：domain:topic 形如 design:color，可省略>',
    '<经验正文 50-150 字>',
    '[RULE]',
    '<置信度 0-1 的小数>',
    '<fingerprint：domain:topic，可省略>',
    '<协作规则正文 50-150 字>',
    '[PREFERENCE]',
    '<置信度 0-1 的小数>',
    '<fingerprint：domain:topic，如 style:business>',
    '<【domain】偏好正文 30-100 字，domain ∈ 风格/语气/格式/内容/流程>',
    ...(task.personaId
      ? ['[CRAFT]', '<置信度 0-1 的小数>', '<fingerprint：domain:topic，可省略>', `<以「${personaName}」人设做同类任务的方法论正文 50-150 字（无则写 SKIPPED）>`]
      : []),
  ].filter(Boolean).join('\n');

  const llm = await callLlm(db, { system, user, companyId: reflection.companyId, timeoutMs: 45_000 });
  const text = llm.content.trim();

  // 全局 SKIPPED（兼容老格式：模型直接回 SKIPPED）
  if (/^SKIPPED/i.test(text)) {
    db.prepare(
      `UPDATE task_reflection SET status='skipped', reflection_text=?, reflected_at=? WHERE id=?`,
    ).run(text.slice(0, 500), nowIso(), reflection.id);
    return 'skipped';
  }

  const lesson = parseSection(text, 'LESSON');
  const rule = parseSection(text, 'RULE');
  // E1.2 PREFERENCE 仅在存在用户反馈时解析（无反馈时 LLM 应已 SKIPPED，这里兜底忽略）。
  const preference = feedbackText ? parseSection(text, 'PREFERENCE') : { confidence: 0, body: '', fingerprint: null as string | null };
  const preferenceValid = Boolean(preference.body) && preference.confidence >= 0.7;
  // 蓝图组织批次1：CRAFT 仅在任务穿戴了人设时解析（无人设任务 prompt 不含该段，返回也会被忽略）。
  const craft = task.personaId ? parseSection(text, 'CRAFT') : { confidence: 0, body: '', fingerprint: null as string | null };

  // 各类都没有有效内容 → skipped
  if (!lesson.body && !rule.body && !preferenceValid && !craft.body) {
    db.prepare(
      `UPDATE task_reflection SET status='skipped', reflection_text=?, reflected_at=? WHERE id=?`,
    ).run(text.slice(0, 500), nowIso(), reflection.id);
    return 'skipped';
  }

  // 沉淀 LESSON（原有逻辑）：scope=project，高置信（>=0.8）自动批准生效。
  // candidate_id 字段记 LESSON（保留向后兼容：现有 schema 只有一个 candidate_id 列）。
  let lessonCandidateId: string | null = null;
  if (lesson.body) {
    const candidate = createMemoryCandidate(db, {
      profileId: reflection.profileId,
      scope: 'project',
      companyId: reflection.companyId,
      projectId: reflection.projectId,
      content: lesson.body,
      sourceTaskId: reflection.taskId,
      author: 'agent',
      confidence: lesson.confidence,
      canInfluence: true,
      allowAutoApprove: lesson.confidence >= 0.8,
      fingerprint: lesson.fingerprint,
    });
    lessonCandidateId = candidate.id;
  }

  // 沉淀 RULE（协作规则 / ontology 薄形态）：同 project scope，同样高置信自动批准。
  // 正文加【协作规则】前缀——与 LESSON 区分，便于在 memory 面板识别和将来按类型过滤。
  // 不单独记 candidate_id——可经 memory_candidate.source_task_id 反查（同 task 的第二条 candidate）。
  if (rule.body) {
    createMemoryCandidate(db, {
      profileId: reflection.profileId,
      scope: 'project',
      companyId: reflection.companyId,
      projectId: reflection.projectId,
      content: `【协作规则】${rule.body}`,
      sourceTaskId: reflection.taskId,
      author: 'agent',
      confidence: rule.confidence,
      canInfluence: true,
      allowAutoApprove: rule.confidence >= 0.8,
      fingerprint: rule.fingerprint,
    });
  }

  // E1.2 沉淀 PREFERENCE（用户偏好）：scope=personal，author=user 命中 memory.ts:99-101 自动批准（全量注入）。
  // body 带【domain】前缀，为 E2 晋升流 fingerprint 铺路。控量：单次最多 1 条，置信度 < 0.7 不产。
  let preferenceBody = '';
  if (preferenceValid) {
    createMemoryCandidate(db, {
      profileId: reflection.profileId,
      scope: 'personal',
      // 不传 companyId/projectId：personal/skill 记忆是跨组织的用户画像（validateScope 禁止绑定公司/项目）。
      content: preference.body,
      sourceTaskId: reflection.taskId,
      author: 'user',
      confidence: preference.confidence,
      canInfluence: true,
      allowAutoApprove: true,
      fingerprint: preference.fingerprint,
    });
    preferenceBody = preference.body;
  }

  // 蓝图组织批次1：沉淀 CRAFT（人设方法论）：scope=skill + persona_key——挂在人设上跨任务、跨项目复用，
  // 下次任何智能体穿戴同一人设执行任务时经 loadContextMemories 注入。
  // 高置信（>=0.8）自动批准（命中 memory.ts 的人设键自动批准门）；低置信进候选队列人工审核。
  let craftBody = '';
  if (craft.body && task.personaId) {
    createMemoryCandidate(db, {
      profileId: reflection.profileId,
      scope: 'skill',
      personaKey: task.personaId,
      content: craft.body,
      sourceTaskId: reflection.taskId,
      author: 'agent',
      confidence: craft.confidence,
      canInfluence: true,
      allowAutoApprove: craft.confidence >= 0.8,
      fingerprint: craft.fingerprint,
    });
    craftBody = craft.body;
  }

  const summary = [
    lesson.body && `[LESSON] ${lesson.body}`,
    rule.body && `[RULE] ${rule.body}`,
    preferenceBody && `[PREFERENCE] ${preferenceBody}`,
    craftBody && `[CRAFT] ${craftBody}`,
  ]
    .filter(Boolean)
    .join('\n');
  db.prepare(
    `UPDATE task_reflection SET status='done', candidate_id=?, reflection_text=?, reflected_at=? WHERE id=?`,
  ).run(lessonCandidateId, summary.slice(0, 500), nowIso(), reflection.id);
  return 'done';
}

/**
 * 解析双段输出中的某一段（LESSON / RULE）。
 * 格式：[SECTION] 头 → 置信度行 → 正文行。置信度缺省 0.7，正文截断 500 字。
 * 找不到段头或正文为 SKIPPED/空 → 返回空 body（表示该类无沉淀）。
 */
function parseSection(text: string, section: 'LESSON' | 'RULE' | 'PREFERENCE' | 'CRAFT'): { confidence: number; fingerprint: string | null; body: string } {
  const re = new RegExp(`\\[${section}\\]\\s*([\\s\\S]*?)(?=\\[(?:LESSON|RULE|PREFERENCE|CRAFT)\\]|$)`, 'i');
  const match = re.exec(text);
  if (!match) return { confidence: 0.7, fingerprint: null, body: '' };
  const block = match[1]!.trim();
  if (!block || /^SKIPPED/i.test(block)) return { confidence: 0.7, fingerprint: null, body: '' };
  const lines = block.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return { confidence: 0.7, fingerprint: null, body: '' };
  let confidence = 0.7;
  let body = block;
  const firstNum = parseFloat(lines[0]!);
  if (!Number.isNaN(firstNum) && firstNum >= 0 && firstNum <= 1) {
    confidence = firstNum;
    body = lines.slice(1).join('\n').trim();
  }
  // E2.1 fingerprint 行：紧跟置信度后，形如 "domain:topic"（如 design:color）；匹配则提取，body 取剩余（兼容旧格式无标签）。
  let fingerprint: string | null = null;
  const bodyLines = body.split('\n').filter((l) => l.trim());
  if (bodyLines.length > 0 && /^[a-z0-9_\u4e00-\u9fa5]+:[a-z0-9_\u4e00-\u9fa5-]+$/i.test(bodyLines[0]!)) {
    fingerprint = bodyLines[0]!.trim().toLowerCase();
    body = bodyLines.slice(1).join('\n').trim();
  }
  body = body.slice(0, 500);
  if (!body || /^SKIPPED/i.test(body)) return { confidence: 0.7, fingerprint: null, body: '' };
  return { confidence, fingerprint, body };
}

/**
 * E1.2 收集与该 task 相关的用户反馈原文，供反思 prompt 提炼用户偏好（PREFERENCE）。
 * 来源：business_review.feedback（验收决策理由）+ task_message(role=user)（task 内追问/回复）。
 * 只取原文、截断，不做语义加工；conversation 群聊太泛，初版不纳入（后续可按 project 聚合）。
 */
function collectUserFeedback(db: DB, taskId: string): string {
  const lines: string[] = [];
  const reviews = db
    .prepare(
      `SELECT feedback, status FROM business_review
       WHERE (task_id = ? OR rework_task_id = ?) AND feedback IS NOT NULL AND feedback != ''
       ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 5`,
    )
    .all(taskId, taskId) as Array<{ feedback: string; status: string }>;
  for (const r of reviews) {
    lines.push(`[验收反馈/${r.status}] ${r.feedback.slice(0, 200)}`);
  }
  const msgs = db
    .prepare(
      `SELECT content FROM task_message
       WHERE task_id = ? AND role = 'user'
       ORDER BY created_at DESC LIMIT 5`,
    )
    .all(taskId) as Array<{ content: string }>;
  for (const m of msgs) {
    const c = (m.content ?? '').trim();
    if (c) lines.push(`[用户追问] ${c.slice(0, 200)}`);
  }
  return lines.join('\n');
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
