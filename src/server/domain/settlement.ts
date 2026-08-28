/**
 * 选择闭环 S2（spec 2026-08-27-selection-loop）：任务结算——趁热把使用结果长到口碑与偏好上。
 *
 * 两层：
 * - 结构化结算 settleTask（全执行器，纯 SQL 不进 LLM，收尾路径同步跑）：
 *   completed + rework=0 + 非讨论 → 每个已加载 skill 记一条 usage success（用户没退回=采纳信号）；
 *   失败/返工/阻断不记票（护栏：失败可能是需求烂不全是工具的锅，工具级真实失败已由
 *   tool-loop/engine 埋点记录；skill 级只加成功票，不搞一票否决）。
 *   偏好事件只在"单一 skill 加载"时落（route 无歧义；多 skill 组合归因不明——宁可不用，不可误用），
 *   source=auto（0.5 权重，防自动路径自我强化）。
 * - 语义结算 drainSemanticSettlements（coordinator drain，economy LLM）：
 *   从 task_message 对话记录读用户在任务过程中的抱怨/纠偏，分类 need-statement（只更新条件）
 *   vs route-complaint（影响口碑）落 preference_event——这是结构化数据看不到、只有对话里有的信号。
 *   实施注记：原 spec 的 CLI resume 方案不需要——对话消息本就持久化在 DB，从 DB 重建统一覆盖
 *   全部执行器（对称），且重建对象只是消息流（非全上下文），成本可控。
 *
 * 挂点：enqueueReflection 第一行调 settleTaskSafely（engine 五个终态路径 + business-review 返工
 * + idle 补历史全覆盖；task_settlement 主键幂等）。
 */
import type { DB } from '../db/client';
import { nowIso } from '../../shared/utils';
import { log } from '../logger';
import { callLlm } from './llm-call';
import { getTask, type Task } from './task';
import { getAgent } from './agent';
import { recordCapabilityUsage } from './capability-quality';
import { recordPreferenceEvent } from './preference';

/** 通用意图槽位（数据不是代码——S3 意图匹配消费，不做单一场景特化）。 */
const INTENT_SLOTS: Array<{ tag: string; tokens: string[] }> = [
  { tag: 'presentation', tokens: ['ppt', '幻灯', '演示文稿', 'slides', 'presentation', '演讲', '路演', 'deck'] },
  { tag: 'deliverable', tokens: ['交付', '导出', '交付物', '文档', 'docx', 'xlsx', 'pdf', 'deliverable', '报告文件', '材料'] },
  { tag: 'report', tokens: ['报告', '分析', '总结', '复盘', 'report', '分析报告', '调研'] },
  { tag: 'debugging', tokens: ['修复', '排查', 'debug', 'bug', '报错', '故障', '失败原因', '排查修'] },
  { tag: 'review', tokens: ['评审', '审查', 'review', '检查', '验收', 'code review'] },
  { tag: 'automation', tokens: ['自动化', '定时', '触发', 'automate', 'cron', 'automation'] },
  { tag: 'documentation', tokens: ['文档化', '说明文档', 'adr', 'readme', 'documentation', '接口文档'] },
  { tag: 'planning', tokens: ['规划', '计划', '拆解', '方案', 'plan', 'planning', '路线图', '排期'] },
  { tag: 'ideation', tokens: ['想法', '创意', '头脑风暴', 'brainstorm', 'ideation', '构思'] },
  { tag: 'implementation', tokens: ['实现', '开发', '功能', '代码', 'implement', 'build', 'feature', '重构', 'refactor'] },
];

/**
 * 词元规则意图分类（S2 结算与 S3 置信判定共用；无命中=other）。
 * Review M2 修复：最长命中定槽——"说明文档"含 deliverable 的'文档'子串，按槽位顺序会恒被
 * deliverable 遮蔽（documentation 的中文词元永不可达）；改为收集全部命中 token、取最长者
 * 所属槽（同长取先声明槽），子串遮蔽消除。
 */
export function classifyIntentTag(text: string): string {
  const lower = (text ?? '').toLowerCase();
  let best: { tag: string; tokenLen: number } | null = null;
  for (const slot of INTENT_SLOTS) {
    for (const token of slot.tokens) {
      if (!lower.includes(token)) continue;
      if (!best || token.length > best.tokenLen) best = { tag: slot.tag, tokenLen: token.length };
    }
  }
  return best?.tag ?? 'other';
}

function resolvedSkillIdsOf(task: Task): string[] {
  const raw = task.inputProtocol?.resolvedSkillIds;
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
}

/** 任务对话里是否有用户消息（语义结算有无素材的判定）。 */
function hasUserMessages(db: DB, taskId: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM task_message WHERE task_id = ? AND role = 'user' LIMIT 1`)
    .get(taskId);
  return row !== undefined;
}

/**
 * 验收未闭环判定（review B1 修复，口径复用 settleMemoryVotes 的推迟谓词 memory.ts:594-621）：
 * 已派验收（acceptance_dispatched）且未落闭环事件（passed/rework/escalated）且验收任务还活着
 * → 推迟结算（此刻 rework_count 尚未终值，先记票会被验收返工推翻且不可撤回）；
 * 验收任务死亡（failed/cancelled）= 事后门放行，rework_count 已终值，正常结算。
 */
function acceptanceOutcomePending(db: DB, taskId: string): boolean {
  const row = db.prepare(
    `SELECT json_extract(de.payload_json, '$.reviewTaskId') AS reviewTaskId
     FROM task_event de
     WHERE de.task_id = ? AND de.kind = 'acceptance_dispatched'
       AND NOT EXISTS (
         SELECT 1 FROM task_event te
         WHERE te.task_id = ? AND te.kind IN ('acceptance_passed','acceptance_rework','acceptance_escalated')
       ) LIMIT 1`,
  ).get(taskId, taskId) as { reviewTaskId: string | null } | undefined;
  if (!row?.reviewTaskId) return false;
  const review = db.prepare(`SELECT state FROM task WHERE id=?`).get(row.reviewTaskId) as { state: string } | undefined;
  if (!review) return false; // 验收任务被删=放行
  return !['completed', 'failed', 'cancelled'].includes(review.state);
}

/** 结算 epoch（review M4）：早于此刻的任务补结算只写标记不记票——防 idle 补历史把旧任务变成等权票稀释口碑。 */
const SETTLEMENT_EPOCH = '2026-08-27T00:00:00.000Z';

/**
 * 结构化结算（幂等：task_settlement 主键已存在即跳过；主体单事务防"有票无标记"脏态）。
 * 返回 true=本次实际结算；false=已结算过/暂不结算（非终态或验收未闭环——闭环事件点会补调）。
 */
export function settleTask(db: DB, task: Task): boolean {
  const existing = db.prepare('SELECT 1 FROM task_settlement WHERE task_id = ?').get(task.id);
  if (existing) return false;
  // review M1：非终态拒结算（business-review 对 queued 返工任务入队反思——此时写标记会让
  // 返工任务真正完成后永远跳过结算）；返工任务完成后 enqueueReflection 被 UNIQUE 吞掉、
  // 但闭环事件/收尾路径会再次调用本函数补结算。
  if (!['completed', 'failed', 'blocked', 'cancelled'].includes(task.state)) return false;
  // review B1：验收未闭环推迟（rework_count 未终值，先记票不可撤回）
  if (task.state === 'completed' && acceptanceOutcomePending(db, task.id)) return false;

  const intentTag = classifyIntentTag(`${task.title} ${task.summary}`);
  const skills = resolvedSkillIdsOf(task);
  // 采纳口径：completed + 零返工（返工=中性不记票，归因不明）
  const adopted = task.state === 'completed' && task.reworkCount === 0;
  // review M4：epoch 之前的任务（idle 补历史触达）不记票只写标记
  const beforeEpoch = (task.updatedAt ?? '') < SETTLEMENT_EPOCH;
  // review m5：用户在偏好问询中明确选了"不用专业技能"→ 不记 auto 采纳票（出口信号不能丢）
  const optedOutOfSkills = (task.inputProtocol?.preferenceClarify as { answeredRoute?: unknown } | undefined)?.answeredRoute === '__none__';
  const shouldRecord = adopted && !beforeEpoch && !optedOutOfSkills;

  let settledRoutes: string[] = [];
  let semanticStatus: 'pending' | 'skipped' = 'skipped';

  db.transaction(() => {
    if (task.isDiscussion) {
      db.prepare(`INSERT INTO task_settlement (task_id, outcome, intent_tag, settled_routes_json, semantic_status, settled_at)
                  VALUES (?, ?, 'other', '[]', 'skipped', ?)`)
        .run(task.id, task.state, nowIso());
      return;
    }

    if (shouldRecord) {
      for (const skillId of skills) {
        try {
          recordCapabilityUsage(db, { capabilityId: skillId, outcome: 'success', taskId: task.id });
        } catch {
          /* 结算票据失败不阻断其余 */
        }
      }
      settledRoutes = skills;
    }

    // 偏好事件：仅单一 skill（route 无歧义）+ 记票条件成立 + profile 可解析
    if (shouldRecord && skills.length === 1 && task.assigneeAgentId) {
      const profileId = getAgent(db, task.assigneeAgentId)?.profileId ?? null;
      if (profileId) {
        try {
          recordPreferenceEvent(db, {
            profileId,
            intentTag,
            route: skills[0],
            source: 'auto',
            taskId: task.id,
          });
        } catch {
          /* 偏好落库失败不影响口碑票 */
        }
      }
    }

    semanticStatus = hasUserMessages(db, task.id) ? 'pending' : 'skipped';
    db.prepare(`INSERT INTO task_settlement (task_id, outcome, intent_tag, settled_routes_json, semantic_status, settled_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(task.id, task.state, intentTag, JSON.stringify(settledRoutes), semanticStatus, nowIso());
  })();
  return true;
}

/** enqueueReflection 第一行调用（全挂点收口）；结算失败绝不影响反思主流程。 */
export function settleTaskSafely(db: DB, taskId: string): void {
  try {
    const task = getTask(db, taskId);
    if (task) settleTask(db, task);
  } catch (e) {
    log.warn('usage settlement failed', { taskId, err: e instanceof Error ? e.message : String(e) });
  }
}

export interface SemanticComplaint {
  complaintKind: 'need-statement' | 'route-complaint' | null;
  route: string | null;
  note?: string;
}

/** 语义结算的 LLM 输出解析：容忍包裹文本，非法值归 null（宁可不落，不可误落）。 */
export function parseSemanticComplaint(raw: string): SemanticComplaint {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { complaintKind: null, route: null };
  try {
    const obj = JSON.parse(match[0]) as { complaintKind?: unknown; route?: unknown; note?: unknown };
    const kind = obj.complaintKind === 'need-statement' || obj.complaintKind === 'route-complaint' ? obj.complaintKind : null;
    const route = typeof obj.route === 'string' && obj.route.trim() ? obj.route.trim() : null;
    const note = typeof obj.note === 'string' ? obj.note.slice(0, 200) : undefined;
    return { complaintKind: kind, route, note };
  } catch {
    return { complaintKind: null, route: null };
  }
}

let semanticDrainInFlight = false;

/**
 * B1 配套兜底：验收任务死亡（failed/cancelled，无闭环事件驱动）或其他漏网路径下，
 * 源任务可能停在"completed 但无 task_settlement"状态。扫 1 小时前的孤儿补结算（有界 LIMIT）。
 * 正常路径由验收闭环事件点（acceptance-review）直接补调 settleTaskSafely，本扫描只兜底。
 */
function settleOrphanCompletions(db: DB, limit = 5): number {
  const orphans = db.prepare(
    `SELECT id FROM task
     WHERE state='completed' AND is_discussion=0
       AND updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM task_settlement ts WHERE ts.task_id = task.id)
     ORDER BY updated_at ASC LIMIT ?`,
  ).all(new Date(Date.now() - 3_600_000).toISOString(), limit) as Array<{ id: string }>;
  let settled = 0;
  for (const o of orphans) {
    settleTaskSafely(db, o.id); // void 返回（安全包装）；补结算条数以标记行落库为准，这里不精确计数
    settled++;
  }
  return settled;
}

/**
 * 语义结算 drain（coordinator reflectionTimer 挂钩；单进程串行 + 互斥，与反思 drain 同模式）。
 * 每次最多 maxPerTick 条；事件落库与状态置 done 同事务（review m2：崩溃在两者之间会重复落
 * complaint 事件，而 complaint 权重极高）；route 校验 ∈ 本任务 resolvedSkillIds（review m6：
 * LLM 输出的任意字符串不直接进偏好统计）——不可信即丢弃事件。
 * LLM 失败标 error 不重试（机会主义——结构化结算已完成主体）。
 * 返回本次处理条数。
 */
export async function drainSemanticSettlements(db: DB, maxPerTick = 2): Promise<number> {
  if (semanticDrainInFlight) return 0;
  semanticDrainInFlight = true;
  let processed = 0;
  try {
    settleOrphanCompletions(db);
    const rows = db
      .prepare(`SELECT task_id FROM task_settlement WHERE semantic_status = 'pending' ORDER BY settled_at LIMIT ?`)
      .all(Math.min(Math.max(maxPerTick, 1), 10)) as Array<{ task_id: string }>;
    for (const row of rows) {
      const taskId = row.task_id;
      try {
        const task = getTask(db, taskId);
        if (!task) {
          db.prepare(`UPDATE task_settlement SET semantic_status = 'skipped' WHERE task_id = ?`).run(taskId);
          continue;
        }
        const messages = db
          .prepare(`SELECT role, content FROM task_message WHERE task_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 20`)
          .all(taskId) as Array<{ role: string; content: string }>;
        const userText = messages.map((m) => m.content.slice(0, 500)).join('\n---\n');
        const result = await callLlm(db, {
          system: `你是任务反馈分类器。分析用户在任务过程中的反馈消息，判断是否存在对任务路线/产出的抱怨。
只输出一个 JSON 对象：{"complaintKind": "need-statement" | "route-complaint" | null, "route": string | null, "note": string}
- need-statement：用户在声明需求变化/补充要求（如"我这次是要上台讲的"）——不是对路线的不满
- route-complaint：用户明确不满意当前做法/产物路线（如"太花哨了""改字还得改代码"）
- route：抱怨针对的技能/方法 id，必须从「加载技能」列表中选一个；列表为空或都不匹配则为 null
- 没有抱怨迹象时 complaintKind 为 null。宁可判 null，不可误判。`,
          user: `任务标题：${task.title}\n任务摘要：${task.summary.slice(0, 300)}\n加载技能：${resolvedSkillIdsOf(task).join(', ') || '无'}\n\n用户消息记录：\n${userText}`,
          tier: 'economy',
          timeoutMs: 30_000,
        });
        const parsed = parseSemanticComplaint(result.content);
        const allowedRoutes = new Set(resolvedSkillIdsOf(task));
        const routeTrusted = parsed.route !== null && allowedRoutes.has(parsed.route);
        const profileId = task.assigneeAgentId ? (getAgent(db, task.assigneeAgentId)?.profileId ?? null) : null;
        // 事件 + done 同事务：要么都发生要么都不发生（m2）
        db.transaction(() => {
          if (parsed.complaintKind && routeTrusted && parsed.route && profileId) {
            recordPreferenceEvent(db, {
              profileId,
              intentTag: classifyIntentTag(`${task.title} ${task.summary}`),
              route: parsed.route,
              source: 'user',
              kind: parsed.complaintKind,
              taskId,
            });
          }
          db.prepare(`UPDATE task_settlement SET semantic_status = 'done' WHERE task_id = ?`).run(taskId);
        })();
      } catch (e) {
        log.warn('semantic settlement failed', { taskId, err: e instanceof Error ? e.message : String(e) });
        db.prepare(`UPDATE task_settlement SET semantic_status = 'error' WHERE task_id = ?`).run(taskId);
      }
      processed++;
    }
  } finally {
    semanticDrainInFlight = false;
  }
  return processed;
}
