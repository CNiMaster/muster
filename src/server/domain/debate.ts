/**
 * 对抗评审庭（指挥系统批次4，spec 2026-08-14-command-system-design）。
 *
 * 编排（全确定性，零引擎改动）：
 *   R1 立论（N 个辩手并行，各防御一个选项，干净上下文）
 *   → R2 互攻（各辩手见他人 R1 输出——经 relayOutputToDependents 落进其任务消息——专攻致命伤）
 *   → 裁决任务给评审中心（依赖全部 R2，产出 debateVerdict）
 *   → 置信 ≥ debateMinConfidence：自动采纳（answerClarification）继续执行；
 *     低于阈值：升级用户——优劣表 + 差评清单 + 选项按钮，不是裸问题。
 *
 * 偏好记忆：用户每次选项回答 → decision_record(source=user)；自动采纳 → source=auto。
 * 近期决策记录注入辩手/裁决上下文——用户的选择历史就是偏好画像，升级次数随使用下降。
 *
 * 辩手 = 一次性隐藏临时 agent（role='debater'，stance 注入立场），辩论结束统一回收。
 * 无配额（用户拍板）：两难即辩——成本由辩手任务规模（≤3）与两轮封顶天然约束。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';
import type { DebateVerdict, QuestionOption } from '../../shared/types';
import { getSystemSettings } from './setting';
import { addDependency, answerClarification, cancelTask, createTask, getTask } from './task';
import { addTaskMessage } from './task-message';
import { appendTaskEvent } from './task-event';
import { createTempEmployment, dismissTempWorker } from './temp-worker';
import { ensurePrimaryThread } from './thread';
import { ensureSystemAgents, getJudgeAgentId } from './system-agents';
import { postSystemMessage } from './conversation';
import { getWorkbenchOrNull } from './workbench';

export const DEBATER_ROLE = 'debater';
/** 两轮封顶：R1 立论 + R2 互攻（外部研究：3 轮后收益递减甚至下降——从众塌缩/跑题漂移）。 */
export const DEBATE_MAX_ADVOCATES = 3;

export interface DebateSummary {
  id: string;
  companyId: string;
  projectId: string | null;
  question: string;
  options: QuestionOption[];
  status: 'open' | 'resolved' | 'escalated';
  verdict: DebateVerdict | null;
  originTaskId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface DebateRow {
  id: string;
  project_id: string | null;
  question: string;
  options_json: string;
  rounds_json: string | null;
  verdict_json: string | null;
  status: DebateSummary['status'];
  origin_task_id: string | null;
  origin_scope_kind: string | null;
  origin_scope_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

function debateFromRow(db: DB, r: DebateRow): DebateSummary {
  return {
    id: r.id,
    companyId: getWorkbenchOrNull(db)?.id ?? '',
    projectId: r.project_id,
    question: r.question,
    options: JSON.parse(r.options_json || '[]') as QuestionOption[],
    status: r.status,
    verdict: r.verdict_json ? (JSON.parse(r.verdict_json) as DebateVerdict) : null,
    originTaskId: r.origin_task_id,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export function getDebate(db: DB, id: string): DebateSummary {
  const row = db.prepare('SELECT * FROM debate WHERE id=?').get(id) as DebateRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `debate ${id} not found`);
  return debateFromRow(db, row);
}

export function listDebates(db: DB, companyId?: string, limit = 30): DebateSummary[] {
  const rows = db.prepare('SELECT * FROM debate ORDER BY created_at DESC LIMIT ?').all(limit) as DebateRow[];
  return rows.map((r) => debateFromRow(db, r));
}

/** 近期用户决策记录（偏好画像，注入辩手/裁决上下文）。 */
export function recentDecisions(db: DB, companyId?: string, limit = 5): Array<{ question: string; chosen: string; rationale: string | null; source: string; createdAt: string }> {
  return db.prepare(
    `SELECT question, chosen, rationale, source, created_at FROM decision_record
     ORDER BY created_at DESC LIMIT ?`,
  ).all(limit) as Array<{ question: string; chosen: string; rationale: string | null; source: string; createdAt: string }>;
}

export function recordDecision(db: DB, input: {
  companyId?: string;
  debateId?: string | null;
  question: string;
  options: QuestionOption[];
  chosen: string;
  chosenOptionId?: string | null;
  rationale?: string | null;
  context?: string | null;
  source: 'user' | 'auto';
}): void {
  db.prepare(
    `INSERT INTO decision_record (id, debate_id, question, options_json, chosen, chosen_option_id, rationale, context, source, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    shortId('dr_'), input.debateId ?? null, input.question,
    JSON.stringify(input.options), input.chosen, input.chosenOptionId ?? null,
    input.rationale ?? null, input.context ?? null, input.source, nowIso(),
  );
}

const ADVOCATE_NAMES = ['辩手·甲', '辩手·乙', '辩手·丙'];

function debaterPrompt(option: QuestionOption, allOptions: QuestionOption[]): string {
  const others = allOptions.filter((o) => o.id !== option.id).map((o) => o.label).join('、');
  return `你是对抗式评审庭的辩手，立场已锁定：你全力为「${option.label}」辩护。
- 你的任务分两轮：R1 立论（为什么选它：最强论据 + 诚实承认它已知的最弱点）；R2 互攻（你会看到其他辩手的立论，专攻它们的致命伤——最坏会发生什么、能否接受；同时回应针对你的攻击）。
- 纪律：为立场辩护 ≠ 撒谎。不许编造论据；对方的真弱点要说透，自己的真弱点要承认并给出缓解办法。
- 你看不到发起者的完整上下文，这是有意设计——干净上下文才能摆脱锚定。只基于任务里给你的材料论证。
- 对手立场：${others || '（无）'}。每轮输出 300 字以内，结论先行。`;
}

function createDebater(db: DB, input: { projectId: string; index: number; option: QuestionOption; allOptions: QuestionOption[]; judgeAgentId: string }): string {
  const { agentId } = createTempEmployment(db, {
    role: DEBATER_ROLE,
    requesterAgentId: input.judgeAgentId,
    name: ADVOCATE_NAMES[input.index] ?? `辩手${input.index + 1}`,
    systemPrompt: debaterPrompt(input.option, input.allOptions),
  });
  db.prepare('UPDATE agent_definition SET stance=? WHERE id=?').run(`全力辩护「${input.option.label}」`, agentId);
  db.prepare('UPDATE company_employee SET hidden=1 WHERE legacy_agent_id=?').run(agentId);
  ensurePrimaryThread(db, input.projectId, agentId);
  return agentId;
}

function dismissDebaters(db: DB, originTaskId: string): void {
  const rows = db.prepare(
    `SELECT DISTINCT t.assignee_agent_id AS id FROM task t
     JOIN agent_definition a ON a.id = t.assignee_agent_id
     WHERE t.parent_task_id=? AND a.role=?`,
  ).all(originTaskId, DEBATER_ROLE) as Array<{ id: string }>;
  for (const row of rows) {
    if (!row.id) continue;
    try {
      dismissTempWorker(db, row.id, { confirm: true });
    } catch {
      // 已删/竞态时忽略
    }
  }
}

export interface StartDebateInput {
  companyId: string;
  projectId: string;
  question: string;
  options: QuestionOption[];
  /** 两难的来源任务（waiting_input 挂着等裁决；裁决后自动回答或升级）。 */
  originTaskId: string;
  originScopeKind?: 'workbench' | 'project';
  originScopeId?: string;
}

export interface StartedDebate {
  debateId: string;
  debaterTaskIds: string[];
  verdictTaskId: string;
}

/** 启动一场辩论：R1 立论 → R2 互攻 → 评审裁决，依赖链确定性串联（领取门即调度器）。 */
export function startDebate(db: DB, input: StartDebateInput): StartedDebate {
  if (input.options.length < 2) {
    throw new AppError(ErrorCode.VALIDATION, '评审庭至少需要 2 个选项');
  }
  const { judgeAgentId } = ensureSystemAgents(db);
  // 评审岗是隐形岗，不在 ensureProjectThreads（按可见花名册）覆盖内——显式建线程
  ensurePrimaryThread(db, input.projectId, judgeAgentId);
  const advocates = input.options.slice(0, DEBATE_MAX_ADVOCATES);
  const decisions = recentDecisions(db, input.companyId);

  const debateId = shortId('db_');
  db.prepare(
    `INSERT INTO debate (id, project_id, question, options_json, status, origin_task_id, origin_scope_kind, origin_scope_id, created_at)
     VALUES (?,?,?,?,'open',?,?,?,?)`,
  ).run(debateId, input.projectId, input.question, JSON.stringify(input.options), input.originTaskId, input.originScopeKind ?? null, input.originScopeId ?? null, nowIso());

  const base = {
    projectId: input.projectId,
    parentTaskId: input.originTaskId,
    rootTaskId: getTask(db, input.originTaskId).rootTaskId ?? input.originTaskId,
    dispatcherAgentId: judgeAgentId,
    skipLaunchGate: true,
    priority: 7,
  };
  const decisionBrief = decisions.length
    ? decisions.map((d) => `- 问「${d.question.slice(0, 60)}」选了「${d.chosen}」${d.rationale ? `（${d.rationale.slice(0, 80)}）` : ''}`).join('\n')
    : '';

  const r1Ids: string[] = [];
  const r2Ids: string[] = [];
  const debaterAgentIds: string[] = [];
  for (const [index, option] of advocates.entries()) {
    const debaterAgentId = createDebater(db, {
      projectId: input.projectId,
      index,
      option,
      allOptions: input.options,
      judgeAgentId,
    });
    debaterAgentIds.push(debaterAgentId);

    // R1 立论 + R2 互攻（R2 依赖全部 R1——领取门保证互攻时能看到所有立论）
    const roundBase = {
      question: input.question,
      options: input.options,
      debateId,
      ...(decisionBrief ? { userDecisions: decisionBrief } : {}),
    };
    const r1 = createTask(db, {
      ...base,
      assigneeAgentId: debaterAgentId,
      title: `[辩论·立论] 为「${option.label}」辩护`,
      inputProtocol: {
        trigger: 'debate_round',
        debate: { ...roundBase, round: 1, duty: '立论', defendOptionId: option.id },
        relayOutputToDependents: true,
      },
    });
    const r2 = createTask(db, {
      ...base,
      assigneeAgentId: debaterAgentId,
      title: `[辩论·互攻] 攻击其他选项的致命伤`,
      inputProtocol: {
        trigger: 'debate_round',
        debate: { ...roundBase, round: 2, duty: '互攻', defendOptionId: option.id },
        relayOutputToDependents: true,
      },
    });
    r1Ids.push(r1.id);
    r2Ids.push(r2.id);
  }
  for (const r2Id of r2Ids) {
    for (const r1Id of r1Ids) addDependency(db, r2Id, r1Id);
  }

  // 裁决任务给评审中心（干净立场；注入用户决策历史作偏好画像）
  const verdictTask = createTask(db, {
    ...base,
    assigneeAgentId: judgeAgentId,
    title: `[辩论裁决] ${input.question.slice(0, 36)}`,
    inputProtocol: {
      trigger: 'debate_verdict',
      debate: { debateId, question: input.question, options: input.options, judge: true, ...(decisionBrief ? { userDecisions: decisionBrief } : {}) },
      relayOutputToDependents: false,
    },
    priority: 8,
  });
  for (const r2Id of r2Ids) addDependency(db, verdictTask.id, r2Id);

  appendTaskEvent(db, input.originTaskId, 'debate_started', { debateId, advocates: advocates.length });
  return { debateId, debaterTaskIds: [...r1Ids, ...r2Ids], verdictTaskId: verdictTask.id };
}

function formatOptionsContent(question: string, options: QuestionOption[], flaws?: Array<{ optionId: string; flaw: string }>): string {
  return question + '\n' + options.map((o, i) => {
    const flaw = flaws?.find((f) => f.optionId === o.id)?.flaw;
    return `${String.fromCharCode(65 + i)}. ${o.label}${o.detail ? ` — ${o.detail}` : ''}${flaw ? `\n   ⚠ 致命伤：${flaw}` : ''}`;
  }).join('\n');
}

/**
 * 升级用户（低置信 / 辩论中断共用）：任务保持 waiting_input、选项 cons 补致命伤、
 * 任务消息差评清单、对话收到问题原文（可一键选择）。用户已抢先回答则全部跳过（不再打扰）。
 */
function escalateDebateToUser(db: DB, debateId: string, opts: { flaws?: Array<{ optionId: string; flaw: string }>; note: string }): void {
  const debate = getDebate(db, debateId);
  if (!debate.originTaskId) return;
  const origin = getTask(db, debate.originTaskId);
  if (origin.state !== 'waiting_input') return;
  const flaws = opts.flaws ?? [];
  const enriched = origin.questionOptions?.map((o) => {
    const flaw = flaws.find((f) => f.optionId === o.id)?.flaw;
    return flaw ? { ...o, cons: o.cons ? `${o.cons}；${flaw}` : flaw } : o;
  }) ?? null;
  if (enriched) {
    db.prepare('UPDATE task SET question_options_json=? WHERE id=?').run(JSON.stringify(enriched), origin.id);
  }
  addTaskMessage(db, origin.id, {
    author: 'system',
    role: 'dispatch',
    content: `[评审庭] ${opts.note}\n${formatOptionsContent(debate.question, debate.options, flaws)}`,
  });
  const scopeInfo = db.prepare('SELECT origin_scope_kind AS k, origin_scope_id AS s FROM debate WHERE id=?').get(debateId) as { k: string | null; s: string | null };
  if (scopeInfo.k && scopeInfo.s) {
    postSystemMessage(db, {
      scopeKind: scopeInfo.k as 'workbench' | 'project',
      scopeId: scopeInfo.s!,
      role: 'assistant',
      author: getJudgeAgentId(db) ?? 'system',
      content: `[需要你拍板] ${formatOptionsContent(debate.question, debate.options, flaws)}`,
      refTaskId: debate.originTaskId,
    });
  }
}

/**
 * 辩论任务失败处置（failTask 对 debate 任务的分支——评审庭没有引擎兜底，失败必须自救）：
 * R1/R2/裁决任一失败都会让下游依赖永不满足（failed 不算已满足）→ 辩论永挂、辩手泄漏。
 * 处置：标记 escalated（中断说明）→ 取消该辩论剩余任务 → 把原问题直接升级用户 → 回收辩手。
 */
export function handleDebateTaskFailure(db: DB, failedTask: { id: string; inputProtocol: Record<string, unknown>; title: string }, message: string): void {
  const debateInfo = failedTask.inputProtocol?.debate as { debateId?: string } | undefined;
  const debateId = debateInfo?.debateId;
  if (!debateId) return;
  const debate = getDebate(db, debateId);
  if (debate.status !== 'open') return;

  db.prepare("UPDATE debate SET status='escalated', resolved_at=?, verdict_json=? WHERE id=?").run(
    nowIso(),
    JSON.stringify({ confidence: 0, rationale: `辩论中断（Task #${failedTask.title} 失败：${message.slice(0, 200)}），直接转用户拍板。`, flaws: [] }),
    debateId,
  );
  // 取消该辩论剩余未终态任务（R2 兄弟/裁决/其他轮次）
  const actives = db.prepare(
    `SELECT id FROM task
     WHERE parent_task_id=? AND input_protocol_json LIKE '%debate_%'
       AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','paused','blocked')`,
  ).all(debate.originTaskId ?? '') as Array<{ id: string }>;
  for (const row of actives) {
    if (row.id === failedTask.id) continue;
    try {
      cancelTask(db, row.id);
    } catch {
      // 状态竞争时跳过
    }
  }
  if (debate.originTaskId) {
    appendTaskEvent(db, debate.originTaskId, 'debate_failed', { debateId, message: message.slice(0, 300), failedTaskId: failedTask.id });
  }
  escalateDebateToUser(db, debateId, { note: `辩论中断，需要你直接拍板。` });
  dismissDebaters(db, debate.originTaskId ?? '');
}

/**
 * 裁决落定（引擎在评审中心返回 debateVerdict 后调用）：
 * - 置信 ≥ debateMinConfidence 且有推荐项 → 自动采纳：answerClarification(originTask) 继续执行 + 决策记录(auto) + 对话播报。
 * - 否则 → 升级用户：任务保持 waiting_input，选项的 cons 补上致命伤，对话收到问题+差评清单（可一键选择）。
 */
export function finalizeDebate(db: DB, debateId: string, verdict: DebateVerdict): DebateSummary {
  const debate = getDebate(db, debateId);
  if (debate.status !== 'open') return debate; // 幂等
  const minConfidence = getSystemSettings(db).debateMinConfidence;
  const option = verdict.recommendedOptionId
    ? debate.options.find((o) => o.id === verdict.recommendedOptionId)
    : undefined;
  const resolved = Boolean(option) && verdict.confidence >= minConfidence;
  const now = nowIso();

  db.prepare('UPDATE debate SET verdict_json=?, status=?, resolved_at=? WHERE id=?')
    .run(JSON.stringify(verdict), resolved ? 'resolved' : 'escalated', now, debateId);

  const scopeInfo = db.prepare('SELECT origin_scope_kind AS k, origin_scope_id AS s FROM debate WHERE id=?').get(debateId) as { k: string | null; s: string | null };
  const canPost = Boolean(scopeInfo.k && scopeInfo.s);

  if (resolved && option && debate.originTaskId) {
    // 自动采纳 + 决策记录（source=auto 传入 answerClarification，避免再落一条 user 记录污染偏好画像）
    try {
      answerClarification(db, debate.originTaskId, { optionId: option.id, source: 'auto' });
      appendTaskEvent(db, debate.originTaskId, 'debate_resolved', { debateId, optionId: option.id, confidence: verdict.confidence });
    } catch (error) {
      // 任务已被人工回答/取消：辩论结论仍留档，不覆盖人的选择
      appendTaskEvent(db, debate.originTaskId, 'debate_resolved_but_task_changed', { debateId, error: String(error) });
    }
    recordDecision(db, {
      companyId: debate.companyId,
      debateId,
      question: debate.question,
      options: debate.options,
      chosen: option.label,
      chosenOptionId: option.id,
      rationale: verdict.rationale,
      context: '评审庭自动采纳',
      source: 'auto',
    });
    if (canPost) {
      postSystemMessage(db, {
        scopeKind: scopeInfo.k as 'workbench' | 'project',
        scopeId: scopeInfo.s!,
        role: 'event',
        author: 'system',
        content: `[评审庭] 两难已裁决：选择「${option.label}」（置信 ${verdict.confidence.toFixed(2)}）。${verdict.rationale.slice(0, 160)}`,
        refTaskId: debate.originTaskId,
      });
    }
  } else if (debate.originTaskId) {
    // 升级用户（共享路径：补致命伤 + 差评清单 + 对话问题原文；用户已抢先回答则不打扰）
    escalateDebateToUser(db, debateId, {
      flaws: verdict.flaws,
      note: `置信 ${verdict.confidence.toFixed(2)} 低于阈值 ${minConfidence}，需要你拍板。裁决理由：${verdict.rationale.slice(0, 300)}`,
    });
    appendTaskEvent(db, debate.originTaskId, 'debate_escalated', { debateId, confidence: verdict.confidence });
  }

  dismissDebaters(db, debate.originTaskId ?? '');
  return getDebate(db, debateId);
}

/** 用户经 clarify 选择后沉淀决策记录（answerClarification 的选项路径调用）。 */
export function recordDecisionFromClarify(db: DB, taskId: string, option: QuestionOption): void {
  const task = getTask(db, taskId);
  const debateRow = db.prepare("SELECT id FROM debate WHERE origin_task_id=? AND status IN ('open','escalated') ORDER BY created_at DESC LIMIT 1").get(taskId) as { id: string } | undefined;
  recordDecision(db, {
    debateId: debateRow?.id ?? null,
    question: task.question ?? task.title,
    options: task.questionOptions ?? [],
    chosen: option.label,
    chosenOptionId: option.id,
    context: task.title,
    source: 'user',
  });
}

/** 兼容外部引用：确认评审岗存在时返回其 id。 */
export function judgeAgentOf(db: DB): string | null {
  return getJudgeAgentId(db) ?? ensureSystemAgents(db).judgeAgentId;
}
