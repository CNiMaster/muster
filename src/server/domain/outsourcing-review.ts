/**
 * 外包自动验收（阶段四任务 4.2）：AI 对 AI 验收闭环。
 *
 * 流程：
 * 1. 乙方承接任务完成 → 契约 delivered → triggerAutoReview 给甲方第一负责人派 [验收] Task。
 * 2. 甲方第一负责人查看交付物（在甲方项目内），用 done 返回验收结论：
 *    summary 第一行 `VERDICT=completed|changes_requested|rejected`，后续为 feedback。
 * 3. handleOutsourcingReviewTaskCompleted 解析结论：
 *    - completed → 契约完成 + 唤醒甲方源任务（resumeDependents）
 *    - changes_requested → 未超轮次阈值：自动返工（createReworkTask 带 feedback）；
 *      超阈值 → 转人工（提示用户到外包中心人工验收）
 *    - rejected → 契约拒绝
 *    - 解析失败 → 转人工
 *
 * 开关（甲方公司 contractJson）：autoReviewOutsourcing（默认 true）、maxAutoReviewRounds（默认 3）。
 */
import type { DB } from '../db/client';
import {
  getOutsourcingContract,
  submitReview,
  createReworkTask,
  markReviewing,
  type OutsourcingContract,
} from './outsourcing-contract';
import { getProject } from './project';
import { getCompany } from './company';
import { createTask, resumeDependents, type Task } from './task';
import { getAgent } from './agent';
import { postSystemMessage } from './conversation';
import { log } from '../logger';
import { DEFAULT_MAX_AUTO_REVIEW_ROUNDS } from '../../shared/constants';

// 默认自动验收轮次上限（超过后转人工）。常量已上移到 shared/constants.ts，与 submitReview 共用。

const VERDICT_RE = /^VERDICT=(completed|changes_requested|rejected)/i;

export type ReviewVerdict = 'completed' | 'changes_requested' | 'rejected';

/** 解析验收 Task summary → verdict + feedback。 */
export function parseReviewVerdict(summary: string): { verdict: ReviewVerdict; feedback: string } | null {
  const match = VERDICT_RE.exec((summary ?? '').trim());
  if (!match) return null;
  const verdict = match[1].toLowerCase() as ReviewVerdict;
  const feedback = (summary ?? '').trim().slice(match[0].length).replace(/^[\s:：-]+/, '').trim();
  return { verdict, feedback };
}

/** 读取甲方自动验收配置（存于甲方公司 contractJson）。 */
export function getAutoReviewConfig(db: DB, contract: OutsourcingContract): { enabled: boolean; maxRounds: number } {
  try {
    const project = getProject(db, contract.sourceProjectId);
    const company = project ? getCompany(db, project.companyId) : null;
    const contractJson = (company?.contractJson ?? {}) as Record<string, unknown>;
    return {
      enabled: contractJson.autoReviewOutsourcing !== false,
      maxRounds: typeof contractJson.maxAutoReviewRounds === 'number' && contractJson.maxAutoReviewRounds > 0
        ? Math.floor(contractJson.maxAutoReviewRounds)
        : DEFAULT_MAX_AUTO_REVIEW_ROUNDS,
    };
  } catch {
    return { enabled: true, maxRounds: DEFAULT_MAX_AUTO_REVIEW_ROUNDS };
  }
}

/**
 * 契约 delivered 后触发自动验收：给甲方第一负责人派 [验收] Task。
 * 条件不满足（关闭/超阈值/无第一负责人）返回 null。
 */
export function triggerAutoReview(db: DB, contract: OutsourcingContract): Task | null {
  if (contract.state !== 'delivered') return null;
  const config = getAutoReviewConfig(db, contract);
  if (!config.enabled) return null;
  // 返工轮次超过阈值 → 转人工（不再自动派验收）
  if (contract.revisionRound >= config.maxRounds) {
    notifyManualReview(db, contract, `返工已达 ${contract.revisionRound} 轮，转人工验收`);
    return null;
  }
  const project = getProject(db, contract.sourceProjectId);
  if (!project?.firstAgentId) return null;
  const assignee = getAgent(db, project.firstAgentId);
  if (assignee.companyId !== contract.sourceCompanyId) return null;
  // 已存在未完成的验收 Task 不重复派（按 contractId 精确过滤，避免契约间互相阻塞）
  const existing = db
    .prepare(
      `SELECT 1 FROM task WHERE input_protocol_json LIKE ? AND input_protocol_json LIKE ? AND state NOT IN ('completed','cancelled','failed') LIMIT 1`,
    )
    .get(`%"reason":"outsourcing_review"%`, `%"contractId":"${contract.id}"%`);
  if (existing) return null;
  const reviewTask = createTask(db, {
    projectId: contract.sourceProjectId,
    assigneeAgentId: project.firstAgentId,
    title: `[验收] 外包交付：${contract.title}`,
    inputProtocol: {
      reason: 'outsourcing_review',
      contractId: contract.id,
      revisionRound: contract.revisionRound,
      instruction:
        `乙方已交付外包任务「${contract.title}」。请在甲方项目内检查交付物是否符合验收标准，然后调用 done 工具：` +
        `summary 第一行写 VERDICT=completed（达标）或 VERDICT=changes_requested（要求返工）或 VERDICT=rejected（拒绝），` +
        `第二行起写具体的验收反馈（返工要求必须给出明确修改点）。`,
    },
    contextRefs: [`outsourcing_contract:${contract.id}`],
    acceptanceCriteria: contract.acceptanceCriteria,
    priority: 8,
    skipLaunchGate: true,
  });
  // 契约进入 reviewing 态（验收中）
  markReviewing(db, contract.id);
  log.info('auto review triggered', { contractId: contract.id, reviewTaskId: reviewTask.id, revisionRound: contract.revisionRound });
  return reviewTask;
}

/**
 * 验收 Task 完成时调用（engine 的 completeTask 路径）：
 * 解析 verdict 并执行契约流转（completed / changes_requested+返工 / rejected）。
 */
export function handleOutsourcingReviewTaskCompleted(db: DB, task: Task): void {
  const proto = (task.inputProtocol ?? {}) as Record<string, unknown>;
  if (proto.reason !== 'outsourcing_review') return;
  const contractId = typeof proto.contractId === 'string' ? proto.contractId : '';
  if (!contractId) return;
  const contract = getOutsourcingContract(db, contractId);
  const parsed = parseReviewVerdict(task.summary ?? '');
  if (!parsed) {
    notifyManualReview(db, contract, `自动验收无法解析结论（${(task.summary ?? '').slice(0, 80)}），转人工验收`);
    return;
  }
  const { verdict, feedback } = parsed;
  const config = getAutoReviewConfig(db, contract);
  if (verdict === 'completed') {
    submitReview(db, contractId, 'completed', feedback);
    // 唤醒甲方源任务（若因依赖本契约交付而等待）
    if (contract.outsourcedTaskId) {
      try {
        resumeDependents(db, contract.outsourcedTaskId);
      } catch (e) {
        log.warn('resume dependents after outsourcing review failed', { contractId, err: e instanceof Error ? e.message : String(e) });
      }
    }
    notifyAutoReviewResult(db, contract, 'completed', feedback);
  } else if (verdict === 'changes_requested') {
    if (contract.revisionRound >= config.maxRounds) {
      notifyManualReview(db, contract, `返工已达 ${contract.revisionRound} 轮，转人工验收`);
      return;
    }
    submitReview(db, contractId, 'changes_requested', feedback);
    createReworkTask(db, contractId, feedback || '请按反馈返工');
    notifyAutoReviewResult(db, contract, 'changes_requested', feedback);
  } else {
    submitReview(db, contractId, 'rejected', feedback);
    notifyAutoReviewResult(db, contract, 'rejected', feedback);
  }
}

/** 转人工：写甲方项目对话窗口提示用户去外包中心验收。 */
function notifyManualReview(db: DB, contract: OutsourcingContract, reason: string): void {
  try {
    postSystemMessage(db, {
      scopeKind: 'project',
      scopeId: contract.sourceProjectId,
      role: 'system',
      author: 'system',
      content: `⚠️ 外包「${contract.title}」${reason}。请到外包中心人工验收（当前状态：${contract.state}）。`,
    });
  } catch (e) {
    log.warn('notify manual review failed', { contractId: contract.id, err: e instanceof Error ? e.message : String(e) });
  }
}

/** 自动验收结果通知（写甲方项目对话窗口）。 */
function notifyAutoReviewResult(db: DB, contract: OutsourcingContract, verdict: ReviewVerdict, feedback: string): void {
  try {
    const label = verdict === 'completed' ? '验收通过' : verdict === 'changes_requested' ? '要求返工' : '已拒绝';
    postSystemMessage(db, {
      scopeKind: 'project',
      scopeId: contract.sourceProjectId,
      role: 'system',
      author: 'system',
      content: `外包「${contract.title}」${label}${feedback ? `：${feedback.slice(0, 300)}` : ''}`,
    });
  } catch (e) {
    log.warn('notify auto review result failed', { contractId: contract.id, err: e instanceof Error ? e.message : String(e) });
  }
}
