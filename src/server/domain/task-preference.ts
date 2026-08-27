/**
 * 选择闭环 S3（spec 2026-08-27-selection-loop）：三态偏好消费 + 能力适配检查。
 *
 * 定案口径：
 * - 偏好记忆的输出是带置信度的先验，不是决定。三态：
 *   silent（高置信：集中度 ≥0.7 且加权票 ≥2）→ 不打扰，routeHint 注入 inputProtocol 供执行侧参考与审计；
 *   confirm（有明确候选但置信中）→ 确认式默认值问询（questionOptions 带默认徽章，点一下即纠偏）；
 *   none（无意图信号/无候选）→ 完全不问（零打扰是字面意义）。
 * - 偏好永远不能跳过意图识别（classifyIntentTag 先行，other=不打扰）。
 * - skill 选用的用户意向边界：建议式问询（"有个专业技能要不要用"），不自动启用；
 *   抱怨重的路线从候选撤下（complaints ≥ 加权票视为已被用户否定）。
 * - 全程本地（listPlugins + usage_stat + preference_event），无任何联网。
 */
import type { DB } from '../db/client';
import { log } from '../logger';
import { getTask, type Task } from './task';
import { getAgent } from './agent';
import { getIntentRouteStats, recordPreferenceEvent } from './preference';
import { classifyIntentTag } from './settlement';
import { listPlugins } from './plugin-adapter';
import { skillProfileFromPlugin } from './capability-profile';
import type { QuestionOption } from '../../shared/types';

export type RouteGuidanceMode = 'none' | 'silent' | 'confirm';

export interface RouteCandidate {
  id: string;
  label: string;
  fromPreference: boolean;
  profileMatched: boolean;
}

export interface RouteGuidance {
  intentTag: string;
  mode: RouteGuidanceMode;
  /** silent 模式的首选路线（skill id）。 */
  preferredRoute: string | null;
  /** confirm 模式的候选（含默认标记信息）。 */
  candidates: RouteCandidate[];
  defaultRoute: string | null;
  /** 判定依据摘要（审计/日志）。 */
  reason: string;
}

export interface DecideRouteInput {
  /** 用户原话（比任务标题信号更全）。 */
  text: string;
  /** 偏好归属档案（无档案=无偏好召回，只有画像匹配）。 */
  profileId: string | null;
}

const SILENT_CONCENTRATION = 0.7;
const SILENT_MIN_VOTES = 2;
const MAX_CANDIDATES = 3;

/** 三态判定（纯读 + 纯逻辑，无副作用，单测友好）。 */
export function decideRouteGuidance(db: DB, input: DecideRouteInput): RouteGuidance {
  const intentTag = classifyIntentTag(input.text);
  if (intentTag === 'other') {
    return { intentTag, mode: 'none', preferredRoute: null, candidates: [], defaultRoute: null, reason: 'no-intent-signal' };
  }

  const stats = input.profileId ? getIntentRouteStats(db, input.profileId, intentTag) : { totalWeightedVotes: 0, concentration: 0, routes: [] };

  // 能力库画像匹配：本地已启用 skill 的 use-cases 含本意图槽位
  const profiled: RouteCandidate[] = [];
  try {
    for (const plugin of listPlugins(db)) {
      if (plugin.status !== 'enabled') continue;
      const profile = skillProfileFromPlugin(plugin);
      if (!profile || !profile.useCases.includes(intentTag)) continue;
      profiled.push({ id: plugin.id, label: plugin.name, fromPreference: false, profileMatched: true });
      if (profiled.length >= MAX_CANDIDATES) break;
    }
  } catch (e) {
    log.warn('capability profile match failed', { err: e instanceof Error ? e.message : String(e) });
  }

  // 偏好候选（抱怨已吞掉票数的路线撤下）
  const preferred = stats.routes.filter((r) => r.complaints < Math.max(r.weightedVotes, 1)).map((r) => r.route);

  if (stats.totalWeightedVotes >= SILENT_MIN_VOTES && stats.concentration >= SILENT_CONCENTRATION && preferred.length > 0) {
    return {
      intentTag,
      mode: 'silent',
      preferredRoute: preferred[0],
      candidates: [],
      defaultRoute: preferred[0],
      reason: `pref-stable(conc=${stats.concentration.toFixed(2)},votes=${stats.totalWeightedVotes})`,
    };
  }

  // 候选合并：偏好优先，画像补位（去重）
  const seen = new Set<string>();
  const candidates: RouteCandidate[] = [];
  for (const route of preferred) {
    if (seen.has(route)) continue;
    const plugin = safeGetPluginName(db, route);
    candidates.push({ id: route, label: plugin ?? route, fromPreference: true, profileMatched: profiled.some((p) => p.id === route) });
    seen.add(route);
  }
  for (const p of profiled) {
    if (seen.has(p.id)) continue;
    candidates.push(p);
    seen.add(p.id);
  }
  if (candidates.length === 0) {
    return { intentTag, mode: 'none', preferredRoute: null, candidates: [], defaultRoute: null, reason: 'no-candidates' };
  }
  return {
    intentTag,
    mode: 'confirm',
    preferredRoute: null,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    defaultRoute: candidates[0]?.id ?? null,
    reason: `candidates=${candidates.length},conc=${stats.concentration.toFixed(2)},votes=${stats.totalWeightedVotes}`,
  };
}

function safeGetPluginName(db: DB, id: string): string | null {
  try {
    return listPlugins(db).find((p) => p.id === id)?.name ?? null;
  } catch {
    return null;
  }
}

/** inputProtocol 里的问询标记（answerClarification 消费）。 */
interface PreferenceClarifyMark {
  intentTag: string;
  /** optionId → route（"不用技能"选项不在映射里）。 */
  optionRoutes: Record<string, string>;
}

function readClarifyMark(task: Task): PreferenceClarifyMark | null {
  const raw = task.inputProtocol?.preferenceClarify;
  if (!raw || typeof raw !== 'object') return null;
  const mark = raw as { intentTag?: unknown; optionRoutes?: unknown };
  if (typeof mark.intentTag !== 'string' || !mark.optionRoutes || typeof mark.optionRoutes !== 'object') return null;
  const optionRoutes: Record<string, string> = {};
  for (const [k, v] of Object.entries(mark.optionRoutes as Record<string, unknown>)) {
    if (typeof v === 'string') optionRoutes[k] = v;
  }
  return { intentTag: mark.intentTag, optionRoutes };
}

/**
 * 用户消息派发任务后调（仅 postUserMessage 挂点——自动派单/蜂群不问）。
 * silent → routeHint 注入（零行为影响，供执行侧参考+审计）；
 * confirm → 任务转 waiting_input 问询（复用 questionOptions 机制）。
 * 返回 guidance（调用方可记日志）；任何失败吞掉不影响派单主流程。
 */
export function maybeEnqueuePreferenceQuestion(db: DB, task: Task, fullText: string): RouteGuidance | null {
  try {
    const profileId = task.assigneeAgentId ? (getAgent(db, task.assigneeAgentId)?.profileId ?? null) : null;
    const guidance = decideRouteGuidance(db, { text: fullText, profileId });
    if (guidance.mode === 'none') return guidance;

    if (guidance.mode === 'silent' && guidance.preferredRoute) {
      db.prepare(`UPDATE task SET input_protocol_json = ? WHERE id = ?`).run(
        JSON.stringify({ ...task.inputProtocol, routeHint: { route: guidance.preferredRoute, intentTag: guidance.intentTag, reason: guidance.reason } }),
        task.id,
      );
      return guidance;
    }

    // confirm：构建问询选项（默认徽章 + "不用专业技能"出口——用户意向边界）
    const options: QuestionOption[] = guidance.candidates.map((c, i) => ({
      id: `route_${i}`,
      label: c.label,
      detail: c.fromPreference ? '你之前常用（按偏好推荐）' : c.profileMatched ? '匹配此任务类型的专业技能' : undefined,
      pros: c.fromPreference ? '延续上次的选择' : undefined,
      ...(guidance.defaultRoute === c.id ? { isDefault: true } : {}),
    }));
    options.push({ id: 'no_skill', label: '不用专业技能', detail: '按普通任务直接执行' });
    const optionRoutes: Record<string, string> = {};
    guidance.candidates.forEach((c, i) => {
      optionRoutes[`route_${i}`] = c.id;
    });

    db.transaction(() => {
      db.prepare(
        `UPDATE task SET state='waiting_input', question=?, question_options_json=?, clarification_rounds=clarification_rounds+1,
         alignment_state='awaiting_alignment', input_protocol_json=?, updated_at=datetime('now') WHERE id=? AND state='queued'`,
      ).run(
        '这个任务有匹配的专业技能，用哪个路线执行？',
        JSON.stringify(options),
        JSON.stringify({ ...task.inputProtocol, preferenceClarify: { intentTag: guidance.intentTag, optionRoutes } }),
        task.id,
      );
    })();
    return guidance;
  } catch (e) {
    log.warn('preference question enqueue failed', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * answerClarification 的偏好落库（option && source=user 时调）：
 * 落 user route-choice 事件（alternatives=当时候选），完成"问→答→沉淀"闭环。
 */
export function recordPreferenceAnswer(db: DB, task: Task, option: QuestionOption): void {
  try {
    const mark = readClarifyMark(task);
    if (!mark) return;
    const route = mark.optionRoutes[option.id];
    if (!route) return; // "不用专业技能"不落（不是路线选择）
    const profileId = task.assigneeAgentId ? (getAgent(db, task.assigneeAgentId)?.profileId ?? null) : null;
    if (!profileId) return;
    const alternatives = Object.values(mark.optionRoutes).map((r) => ({ id: r }));
    recordPreferenceEvent(db, {
      profileId,
      intentTag: mark.intentTag,
      route,
      alternatives,
      source: 'user',
      taskId: task.id,
    });
  } catch (e) {
    log.warn('preference answer record failed', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
  }
}

/** 供 answerClarification 判定（task 是否本机制问询）。 */
export function hasPreferenceClarifyMark(task: Task): boolean {
  return readClarifyMark(task) !== null;
}

/** task.inputProtocol 读取便捷（engine/审计侧）。 */
export function routeHintOf(task: Task): { route: string; intentTag: string } | null {
  const raw = task.inputProtocol?.routeHint;
  if (!raw || typeof raw !== 'object') return null;
  const hint = raw as { route?: unknown; intentTag?: unknown };
  if (typeof hint.route !== 'string' || typeof hint.intentTag !== 'string') return null;
  return { route: hint.route, intentTag: hint.intentTag };
}
