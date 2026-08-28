/**
 * 蓝图 AI 语义路由（2026-08-28 用户定案：词法命中从读侧穿戴退役）。
 *
 * 为什么：词法匹配（jaccard/子串）本质是猜，跨域歧义（「开发一个新的营销渠道」）
 * 消不干净；命中错误会顺着执行→复盘→记账→进化污染全链，代价远大于无命中。
 * 改 AI 理解后挑选，能力管理承接；**无命中=无蓝图模式**（干净合法态，绝不硬凑）。
 *
 * 语义：
 * - routeBlueprintByAI：active 蓝图（label+描述+主槽人设）直给 AI 零词法召回，
 *   输出 blueprintId/'none' + confidence + 理由；confidence<0.6、LLM 失败、无凭据、
 *   超时、输出非法 → 一律 null（fail-open 无蓝图，绝不回退词法）。
 * - routeAndBackfill：直达创建（左栏一行输入/程序化 API）的任务后台自动配——
 *   仅当任务仍在 queued 且未穿戴过时回填主槽人设（不换 assignee、不派组员——
 *   组员派遣只走创建期显式 blueprintId 路径）；结果落 task_event 对话流可见。
 * - 每任务最多一次 AI 调用（回填成功/放弃后 inputProtocol 留痕，不重试）。
 */
import type { DB } from '../db/client';
import { callLlm } from './llm-call';
import { log } from '../logger';
import { appendTaskEvent } from './task-event';
import { getTask } from './task';
import { listBlueprints, currentBlueprintVersion, type Blueprint } from './blueprint';
import { getPersona } from './persona-library';

/** 候选上限：蓝图库极多时按预制优先+战绩排序截断（提示词预算防护）。 */
const MAX_CANDIDATES = 30;
/** 置信门槛：低于此值视为无匹配（宁缺勿错）。 */
const CONFIDENCE_THRESHOLD = 0.6;

export interface BlueprintRouteResult {
  /** null=无蓝图模式（含低置信/失败/无凭据）。 */
  blueprintId: string | null;
  confidence: number;
  reason: string;
}

/** 候选清单：仅现役，预制优先、战绩次之（listBlueprints 已按战绩排序，这里稳定重排）。 */
function activeCandidates(db: DB): Blueprint[] {
  return listBlueprints(db)
    .filter((bp) => bp.status === 'active')
    .sort((a, b) => {
      const presetA = a.source === 'preset' ? 1 : 0;
      const presetB = b.source === 'preset' ? 1 : 0;
      if (presetA !== presetB) return presetB - presetA;
      return b.wins + b.losses - (a.wins + a.losses);
    })
    .slice(0, MAX_CANDIDATES);
}

function candidateLine(bp: Blueprint): string {
  const main = bp.staffing[0];
  const mainName = main ? (getPersona(main.personaId)?.name ?? main.personaName) : '';
  const desc = (bp.description || '').replace(/\s+/g, ' ').slice(0, 120);
  return `- ${bp.id} | ${bp.label} | 主槽人设：${mainName} | ${desc}`;
}

/** 从 LLM 输出提取 JSON 对象（容忍 markdown 围栏与前后噪声）。 */
function extractJsonish(text: string): Record<string, unknown> | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fence ? fence[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * AI 语义路由：给定任务标题（+可选简述），从 active 蓝图里挑一张或判无匹配。
 * 任何失败路径都返回 null 蓝图（fail-open），调用方无须 try。
 */
export async function routeBlueprintByAI(
  db: DB,
  input: { taskTitle: string; taskBrief?: string },
): Promise<BlueprintRouteResult> {
  const candidates = activeCandidates(db);
  if (candidates.length === 0) {
    return { blueprintId: null, confidence: 1, reason: '蓝图库为空（无蓝图模式）' };
  }
  const system = [
    '你是工作台的能力管理路由器：根据任务标题与简述，从候选蓝图（打法包）中选出最匹配的一张；',
    '没有任何一张真正匹配时必须选 none——错误穿戴会误导执行与复盘，宁可不穿。',
    '只输出一个 JSON 对象，格式：{"blueprintId":"<候选 id 或 none>","confidence":<0到1>,"reason":"一句话理由"}。',
  ].join('\n');
  const user = [
    `任务标题：${input.taskTitle}`,
    input.taskBrief ? `任务简述：${input.taskBrief.slice(0, 400)}` : '',
    '候选蓝图：',
    ...candidates.map(candidateLine),
  ].filter(Boolean).join('\n');

  try {
    const llm = await callLlm(db, { system, user, tier: 'economy', timeoutMs: 8_000 });
    const parsed = extractJsonish(llm.content.trim());
    const rawId = typeof parsed?.blueprintId === 'string' ? parsed.blueprintId.trim() : '';
    const confidence = typeof parsed?.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0;
    const reason = typeof parsed?.reason === 'string' ? parsed.reason.slice(0, 120) : '';
    if (!rawId || rawId === 'none') {
      return { blueprintId: null, confidence, reason: reason || 'AI 判定无匹配蓝图' };
    }
    if (!candidates.some((bp) => bp.id === rawId)) {
      log.warn('blueprint route: LLM returned unknown id', { rawId });
      return { blueprintId: null, confidence, reason: 'AI 返回了候选之外的蓝图（按无匹配处理）' };
    }
    if (confidence < CONFIDENCE_THRESHOLD) {
      return { blueprintId: null, confidence, reason: `置信不足（${confidence.toFixed(2)}）：${reason || '无匹配'}` };
    }
    return { blueprintId: rawId, confidence, reason };
  } catch (error) {
    log.warn('blueprint route: LLM unavailable, keep unrouted', {
      err: error instanceof Error ? error.message : String(error),
    });
    return { blueprintId: null, confidence: 0, reason: 'AI 路由不可用（无蓝图模式）' };
  }
}

/**
 * 直达路径后台自动配：创建后回填穿戴。幂等安全——单条 UPDATE 守卫
 * state='queued' AND persona_id IS NULL，任务已开跑/已被穿则零改动走放弃路径。
 * 回填只穿主槽人设+班底协作提示注入，不换 assignee、不派组员（组员只走创建期显式 blueprintId）。
 */
export async function routeAndBackfill(db: DB, taskId: string): Promise<void> {
  try {
    const task = getTask(db, taskId);
    const proto = (task.inputProtocol ?? {}) as Record<string, unknown>;
    // 幂等+资格守卫：已穿戴人设/已有蓝图/已定真实班底模式的任务不再路由
    // （staffingMode==='unrouted' 是「可穿戴但未路由」的待路由标记，不在此列）；
    // 显式注入技能/能力/知识的任务与 createTask 穿戴块同规则——显式指定抑制蓝图穿戴。
    const realMode = typeof proto.staffingMode === 'string' && proto.staffingMode !== 'unrouted';
    const hasExplicitInjection = ['requiredSkillIds', 'requiredCapabilityIds', 'knowledgeTargets'].some(
      (key) => Array.isArray(proto[key]) && (proto[key] as unknown[]).length > 0,
    );
    if (task.personaId || proto.blueprintMatched || realMode || hasExplicitInjection) {
      return;
    }
    const route = await routeBlueprintByAI(db, {
      taskTitle: task.title,
      taskBrief: typeof proto.goal === 'string' ? proto.goal : undefined,
    });
    if (!route.blueprintId) {
      appendTaskEvent(db, taskId, 'blueprint_route_skipped', { reason: route.reason });
      return;
    }
    const row = db.prepare("SELECT * FROM blueprint WHERE id=? AND status='active'").get(route.blueprintId) as
      | { id: string; label: string; staffing_json: string }
      | undefined;
    if (!row) {
      appendTaskEvent(db, taskId, 'blueprint_route_skipped', { reason: '蓝图在路由期间失效' });
      return;
    }
    const staffing = JSON.parse(row.staffing_json ?? '[]') as Array<{ personaId: string; personaName: string; role?: string }>;
    const main = staffing[0];
    if (!main || !getPersona(main.personaId)) {
      appendTaskEvent(db, taskId, 'blueprint_route_skipped', { reason: '蓝图主槽人设缺失' });
      return;
    }
    const crew = staffing.slice(1).map((s) => ({
      name: s.personaName,
      summary: getPersona(s.personaId)?.description ?? '',
    }));
    // LLM 调用窗口（≤8s）内 protocol 可能被改（gate 确认/用户编辑）——await 之后重读最新版再合并，
    // 且重读到 UPDATE 之间无 await（Node 单线程同步段），无丢失更新窗口。
    const fresh = getTask(db, taskId);
    const freshProto = (fresh.inputProtocol ?? {}) as Record<string, unknown>;
    if (fresh.personaId || freshProto.blueprintMatched) {
      appendTaskEvent(db, taskId, 'blueprint_route_skipped', { reason: '任务已被穿戴，放弃回填' });
      return;
    }
    const nextProto = {
      ...freshProto,
      blueprintMatched: row.id,
      blueprintLabel: row.label,
      blueprintVersion: currentBlueprintVersion(db, row.id),
      blueprintScore: route.confidence,
      blueprintRoutedBy: 'ai',
      blueprintRouteReason: route.reason,
      ...(crew.length > 0 ? { staffingNotes: crew } : {}),
      staffingMode: 'official_benchmark',
    };
    // 竞态安全：仅当任务仍处 queued 且未被穿戴时生效（changes=0 → 已开跑/已被穿，放弃）
    const result = db.prepare(
      "UPDATE task SET persona_id=?, input_protocol_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state='queued' AND persona_id IS NULL",
    ).run(main.personaId, JSON.stringify(nextProto), taskId);
    if (result.changes === 0) {
      appendTaskEvent(db, taskId, 'blueprint_route_skipped', { reason: '任务已开始执行，放弃回填' });
      return;
    }
    appendTaskEvent(db, taskId, 'blueprint_routed', {
      blueprintId: row.id,
      blueprintLabel: row.label,
      personaId: main.personaId,
      personaName: main.personaName,
      confidence: route.confidence,
      reason: route.reason,
      crewNames: crew.map((c) => c.name),
    });
  } catch (error) {
    // 兜底防线：后台回填任何异常都不许影响任务本身
    log.warn('blueprint route backfill failed', {
      taskId,
      err: error instanceof Error ? error.message : String(error),
    });
  }
}
