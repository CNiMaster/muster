/**
 * R2：任务级自动验收（收尾环节）。
 *
 * 泛化外包自动验收模式（outsourcing-review.ts）到普通任务：
 * - 触发：任务 completed 且有验收标准、工作台 autoReview 开关未关（默认开）、产出者不是验收员本人。
 * - 流程：派「[验收]」Task 给验收员（可见员工，可对话）→ 验收员按 VERDICT=PASS|FAIL|CHANGES
 *   + CONFIDENCE 判定 → PASS 交付留痕 / FAIL|CHANGES 派返工（继承验收标准）/
 *   低置信或解析失败升级用户（对话播报 + 事件留痕）。
 * - 兜底：验收任务失败走引擎通用失败播报（放行留痕，不阻塞主任务——验收是事后门）。
 * - 用户覆盖：工作台 contractJson.autoReview === false 关闭自动验收；验收员可对话调整。
 */
import type { DB } from '../db/client';
import type { AcceptanceItem, Task } from './task';
import { createTask, getTask } from './task';
import { appendTaskEvent } from './task-event';
import { getProject } from './project';
import { getWorkbench } from './workbench';
import { getAgent } from './agent';
import { postSystemMessage } from './conversation';
import { promoteProjectStagingIfAny } from './staging';
import { ensurePrimaryThread } from './thread';
import { ensureAcceptanceOfficer, ACCEPTANCE_OFFICER_ROLE } from './acceptance-officer';
import { advanceChecklist } from './checklist';
import { log } from '../logger';

/** 验收判定置信阈值：低于则升级用户。 */
export const ACCEPTANCE_MIN_CONFIDENCE = 0.6;

/** Review 修复 I2：验收→返工轮回上限（含首次返工；超限升级用户，对齐外包 maxAutoReviewRounds 先例）。 */
export const MAX_ACCEPTANCE_REWORK_ROUNDS = 3;

const VERDICT_RE = /^VERDICT=(PASS|FAIL|CHANGES)/i;
const CONFIDENCE_RE = /CONFIDENCE=(\d+(?:\.\d+)?)/i;

export type AcceptanceVerdict = 'PASS' | 'FAIL' | 'CHANGES';

/** 解析验收 Task summary → verdict + confidence + feedback。 */
export function parseAcceptanceVerdict(summary: string): { verdict: AcceptanceVerdict; confidence: number; feedback: string } | null {
  const trimmed = (summary ?? '').trim();
  const match = VERDICT_RE.exec(trimmed);
  if (!match) return null;
  const confidenceMatch = CONFIDENCE_RE.exec(trimmed);
  const confidence = confidenceMatch ? Math.min(1, Math.max(0, Number.parseFloat(confidenceMatch[1]!))) : 0.5;
  const feedback = trimmed
    .slice(match[0].length)
    .replace(CONFIDENCE_RE, '')
    .replace(/^[\s:：\-—\n]+/, '')
    .trim()
    .slice(0, 2000);
  return { verdict: match[1].toUpperCase() as AcceptanceVerdict, confidence, feedback };
}

interface AcceptanceReviewCtx {
  sourceTaskId: string;
  criteria: AcceptanceItem[];
  artifacts: Array<{ path: string; kind: string }>;
  summary: string;
}

function readCtx(task: Task): AcceptanceReviewCtx | null {
  const proto = (task.inputProtocol ?? {}) as Record<string, unknown>;
  const review = proto.acceptanceReview as Record<string, unknown> | undefined;
  if (!review || typeof review !== 'object') return null;
  const sourceTaskId = typeof review.sourceTaskId === 'string' ? review.sourceTaskId : null;
  if (!sourceTaskId) return null;
  return {
    sourceTaskId,
    criteria: Array.isArray(review.criteria) ? (review.criteria as AcceptanceItem[]) : [],
    artifacts: Array.isArray(review.artifacts)
      ? (review.artifacts as Array<{ path: string; kind: string }>)
      : [],
    summary: typeof review.summary === 'string' ? review.summary : '',
  };
}

/** 工作台是否开启自动验收（默认开；contractJson.autoReview === false 关闭）。 */
export function isAutoAcceptanceEnabled(db: DB, _companyId: string): boolean {
  const company = getWorkbench(db);
  const contractJson = (company.contractJson ?? {}) as Record<string, unknown>;
  return contractJson.autoReview !== false;
}

/**
 * 任务完成后按需触发自动验收（引擎 completed 分支调用）。
 * 条件：有验收标准 + 开关开 + 产出者不是验收员 + 该任务不是验收任务自身 + 未派过（幂等）。
 * Review 修复 I3：外包验收任务（reason=outsourcing_review）排除——它的闭环自带返工/转人工，
 * 再叠验收员会造成"验收员审外包验收员"的双重返工生成器。
 * 条件不满足静默返回 null。
 */
export function maybeTriggerAcceptanceReview(db: DB, completedTask: Task): Task | null {
  if (completedTask.acceptanceCriteria.length === 0) return null;
  const project = getProject(db, completedTask.projectId);
  if (!isAutoAcceptanceEnabled(db, project.companyId)) return null;
  const assignee = completedTask.assigneeAgentId ? getAgent(db, completedTask.assigneeAgentId) : null;
  if (assignee?.role === ACCEPTANCE_OFFICER_ROLE) return null;
  const proto = (completedTask.inputProtocol ?? {}) as Record<string, unknown>;
  if (proto.acceptanceReview) return null; // 验收任务自身不再触发验收
  if (proto.reason === 'outsourcing_review') return null; // 外包验收闭环自成体系，不叠加
  // Review 修复 I3（终审补全）：外包承接/返工任务由外包验收闭环负责（交付标记 + 甲方 triggerAutoReview），
  // 再叠验收员会形成乙方侧双重返工生成器，且与交付播报存在竞态。
  if (proto.type === 'outsourcing' || proto.type === 'outsourcing_rework') return null;
  // 幂等：已派过验收（事件留痕）不再重复派
  const dispatched = db.prepare(
    "SELECT 1 FROM task_event WHERE task_id=? AND kind='acceptance_dispatched' LIMIT 1",
  ).get(completedTask.id);
  if (dispatched) return null;

  const officerId = ensureAcceptanceOfficer(db);
  ensurePrimaryThread(db, project.id, officerId);
  // Review 修复 Minor：派发 + 留痕同事务（崩溃中断不会重派）
  const reviewTask = db.transaction(() => {
    const task = createTask(db, {
      projectId: project.id,
      assigneeAgentId: officerId,
      // 修复轮批次 G：验收任务挂源任务的项目任务载体——worktree 从任务集成分支切出，看到的是集成后的整体
      ...(completedTask.projectTaskId ? { projectTaskId: completedTask.projectTaskId } : {}),
      title: `[验收] ${completedTask.title}`,
      // 立场独立性：验收员不穿戴蓝图人设（否则可能穿上与产出者同款专家外套，同行评审同行）
      exemptBlueprintMatch: true,
      inputProtocol: {
        acceptanceReview: {
          sourceTaskId: completedTask.id,
          // staging 一期：源任务属蜂群系时，验收任务 worktree 从 staging 集成现场切出（engine 据此选基线）
          ...(completedTask.swarmId ? { sourceSwarmId: completedTask.swarmId } : {}),
          criteria: completedTask.acceptanceCriteria,
          artifacts: completedTask.artifacts.map((a) => ({ path: a.path, kind: a.kind })),
          summary: (completedTask.summary ?? '').slice(0, 2000),
        },
        // Review 修复 Minor：给验收员的显式说明（避免"本任务尚未明确验收标准"的误导样板）
        instruction: [
          '你是验收员。对照下列验收标准与产出者自评，独立判定本次交付：',
          ...completedTask.acceptanceCriteria.map(
            (item, i) => `${i + 1}. [${item.id}] ${item.criterion}${item.met === undefined ? '' : item.met ? '（产出者自评：达标）' : '（产出者自评：未达标）'}`,
          ),
          completedTask.artifacts.length > 0
            ? `产物：${completedTask.artifacts.map((a) => a.path).join('、')}`
            : '（本任务无已登记产物）',
          '完成时 summary 按契约返回：VERDICT=PASS|FAIL|CHANGES 换行 CONFIDENCE=0~1 换行 具体意见。',
        ].join('\n'),
      },
      priority: 6,
    });
    appendTaskEvent(db, completedTask.id, 'acceptance_dispatched', {
      reviewTaskId: task.id,
      officerAgentId: officerId,
      criteriaCount: completedTask.acceptanceCriteria.length,
    });
    return task;
  })();
  return reviewTask;
}

/**
 * 验收任务完成后落地判定（引擎 completed 分支调用）。
 * - PASS（置信 ≥ 阈值）→ 源任务留痕 acceptance_passed（交付）。
 * - FAIL / CHANGES（置信 ≥ 阈值）→ 派「[返工]」Task（继承验收标准 + feedback，rework_count++）。
 * - 低置信 / 解析失败 → 升级用户：工作台对话播报 + 源任务留痕 acceptance_escalated。
 * 任何失败都不抛（验收是事后门，不阻断主流程）。
 */
export function handleAcceptanceReviewTaskCompleted(db: DB, reviewTask: Task): void {
  const ctx = readCtx(reviewTask);
  if (!ctx) return; // 非验收任务
  try {
    const source = getTask(db, ctx.sourceTaskId);
    const parsed = parseAcceptanceVerdict(reviewTask.summary ?? '');
    const project = getProject(db, source.projectId);
    const officerName = reviewTask.assigneeAgentId
      ? (() => { try { return getAgent(db, reviewTask.assigneeAgentId).name; } catch { return '验收员'; } })()
      : '验收员';

    if (!parsed) {
      // 解析失败 → 升级用户
      postSystemMessage(db, {
        scopeKind: 'workbench',
        scopeId: project.companyId,
        role: 'system',
        author: officerName,
        content: `[验收升级] 「${source.title}」的验收意见无法解析，请人工确认。`,
      });
      appendTaskEvent(db, source.id, 'acceptance_escalated', { reason: 'unparseable', reviewTaskId: reviewTask.id });
      return;
    }

    if (parsed.confidence < ACCEPTANCE_MIN_CONFIDENCE) {
      // 低置信 → 升级用户
      postSystemMessage(db, {
        scopeKind: 'workbench',
        scopeId: project.companyId,
        role: 'system',
        author: officerName,
        content: `[验收升级] 「${source.title}」验收判定置信不足（${parsed.confidence.toFixed(2)}），请人工确认：${parsed.feedback || '（无具体意见）'}`,
      });
      appendTaskEvent(db, source.id, 'acceptance_escalated', {
        reason: 'low-confidence',
        confidence: parsed.confidence,
        feedback: parsed.feedback,
        reviewTaskId: reviewTask.id,
      });
      return;
    }

    if (parsed.verdict === 'PASS') {
      appendTaskEvent(db, source.id, 'acceptance_passed', {
        reviewTaskId: reviewTask.id,
        confidence: parsed.confidence,
        feedback: parsed.feedback,
      });
      // 批次三第二片：清单条目验收 PASS → 自动解锁下一条（幂等：advance 只认当前 cursor 条目）
      if (source.projectTaskId) {
        try {
          const advance = advanceChecklist(db, source.projectTaskId, source.id);
          if (advance.done) {
            appendTaskEvent(db, source.id, 'checklist_completed', { projectTaskId: source.projectTaskId });
          }
        } catch (e) {
          log.warn('checklist advance failed on acceptance pass', { sourceTaskId: source.id, err: String(e) });
        }
      }
      // staging 一期：蜂群系源任务验收通过 → 集成现场 promote 回主干
      if (source.swarmId) {
        const promote = promoteProjectStagingIfAny(db, source.projectId, 'acceptance-passed');
        try {
          postSystemMessage(db, {
            scopeKind: 'project',
            scopeId: source.projectId,
            role: 'system',
            author: '验收员',
            content: promote.promoted
              ? `[staging 已合并] 蜂群产物通过验收，集成现场已合并回主干（${promote.message}）。`
              : `[staging 提示] 验收通过，但未执行合并：${promote.message}${promote.conflicts?.length ? `（冲突：${promote.conflicts.join('、')}）` : ''}`,
          });
        } catch { /* 播报失败不阻断 */ }
      }
      return;
    }

    // FAIL / CHANGES → 派返工（继承验收标准 + feedback；rework_count 累计；模式对齐 business-review 返工）
    // Review 修复 I2：轮回上限——返工链（payload.reviewRound）超限升级用户，不再无限派返工。
    // Review 修复 Minor：assignee 预检——原产出者已离职/被回收时升级用户而非静默丢判定。
    if (!source.assigneeAgentId) {
      appendTaskEvent(db, source.id, 'acceptance_escalated', {
        reason: 'no-assignee',
        feedback: parsed.feedback,
        reviewTaskId: reviewTask.id,
      });
      return;
    }
    try {
      getAgent(db, source.assigneeAgentId);
    } catch {
      postSystemMessage(db, {
        scopeKind: 'workbench',
        scopeId: project.companyId,
        role: 'system',
        author: officerName,
        content: `[验收升级] 「${source.title}」判定为 ${parsed.verdict}，但原产出者已不在花名册，请人工处理。意见：${parsed.feedback || '（无）'}`,
      });
      appendTaskEvent(db, source.id, 'acceptance_escalated', {
        reason: 'assignee-gone',
        feedback: parsed.feedback,
        reviewTaskId: reviewTask.id,
      });
      return;
    }
    const prevPayload = ((source.inputProtocol ?? {}) as { payload?: { reviewRound?: number } }).payload;
    const nextRound = (prevPayload?.reviewRound ?? 0) + 1;
    if (nextRound > MAX_ACCEPTANCE_REWORK_ROUNDS) {
      postSystemMessage(db, {
        scopeKind: 'workbench',
        scopeId: project.companyId,
        role: 'system',
        author: officerName,
        content: `[验收升级] 「${source.title}」已返工 ${MAX_ACCEPTANCE_REWORK_ROUNDS} 轮仍未通过验收，请人工接管。意见：${parsed.feedback || '（无）'}`,
      });
      appendTaskEvent(db, source.id, 'acceptance_escalated', {
        reason: 'max-rounds',
        round: nextRound,
        feedback: parsed.feedback,
        reviewTaskId: reviewTask.id,
      });
      return;
    }
    const rework = createTask(db, {
      projectId: source.projectId,
      assigneeAgentId: source.assigneeAgentId,
      // 修复轮批次 G：返工任务挂源任务的项目任务载体（同款任务级集成区基线）
      ...(source.projectTaskId ? { projectTaskId: source.projectTaskId } : {}),
      title: `[返工] ${source.title}`,
      // 返工继承原验收标准：穿戴人设由原任务语义决定，不再叠加蓝图匹配
      exemptBlueprintMatch: true,
      inputProtocol: {
        type: 'business_rework',
        payload: {
          feedback: parsed.feedback,
          decision: parsed.verdict,
          previousReviewId: reviewTask.id,
          sourceTaskId: source.id,
          // staging 一期：蜂群系返工任务同样从 staging 集成现场切出
          ...(source.swarmId ? { sourceSwarmId: source.swarmId } : {}),
          reviewRound: nextRound,
        },
      },
      acceptanceCriteria: ctx.criteria,
      priority: source.priority,
    });
    db.prepare('UPDATE task SET rework_count = rework_count + 1 WHERE id=?').run(source.id);
    appendTaskEvent(db, source.id, 'acceptance_rework', {
      reworkTaskId: rework.id,
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      feedback: parsed.feedback,
      reviewTaskId: reviewTask.id,
    });
    postSystemMessage(db, {
      scopeKind: 'workbench',
      scopeId: project.companyId,
      role: 'system',
      author: officerName,
      content: `[验收返工] 「${source.title}」未通过验收（${parsed.verdict}，置信 ${parsed.confidence.toFixed(2)}），已派返工任务。意见：${parsed.feedback || '（无）'}`,
    });
  } catch (e) {
    log.warn('acceptance review handling failed', {
      reviewTaskId: reviewTask.id,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
