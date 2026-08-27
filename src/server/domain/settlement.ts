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

/** 通用意图槽位（数据不是代码——S3 意图匹配消费，不做单一场景特化）。顺序=优先级（更具体的在前）。 */
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

/** 词元规则意图分类（S2 结算与 S3 置信判定共用；无命中=other）。 */
export function classifyIntentTag(text: string): string {
  const lower = (text ?? '').toLowerCase();
  for (const slot of INTENT_SLOTS) {
    for (const token of slot.tokens) {
      if (lower.includes(token)) return slot.tag;
    }
  }
  return 'other';
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
 * 结构化结算（幂等：task_settlement 主键已存在即跳过）。
 * 返回 true=本次实际结算；false=已结算过（或讨论任务跳过）。
 */
export function settleTask(db: DB, task: Task): boolean {
  const existing = db.prepare('SELECT 1 FROM task_settlement WHERE task_id = ?').get(task.id);
  if (existing) return false;
  // 讨论任务不结算（不产生口碑/偏好语义）
  if (task.isDiscussion) {
    db.prepare(`INSERT INTO task_settlement (task_id, outcome, intent_tag, settled_routes_json, semantic_status, settled_at)
                VALUES (?, ?, 'other', '[]', 'skipped', ?)`)
      .run(task.id, task.state, nowIso());
    return true;
  }

  const intentTag = classifyIntentTag(`${task.title} ${task.summary}`);
  const skills = resolvedSkillIdsOf(task);
  // 采纳口径：completed + 零返工（返工=中性不记票，归因不明）
  const adopted = task.state === 'completed' && task.reworkCount === 0;

  if (adopted) {
    for (const skillId of skills) {
      try {
        recordCapabilityUsage(db, { capabilityId: skillId, outcome: 'success', taskId: task.id });
      } catch {
        /* 结算票据失败不阻断其余 */
      }
    }
  }

  // 偏好事件：仅单一 skill（route 无歧义）+ 采纳 + profile 可解析
  let settledRoutes: string[] = adopted ? skills : [];
  if (adopted && skills.length === 1 && task.assigneeAgentId) {
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
        settledRoutes = skills;
      } catch {
        /* 偏好落库失败不影响口碑票 */
      }
    }
  }

  const semanticStatus = hasUserMessages(db, task.id) ? 'pending' : 'skipped';
  db.prepare(`INSERT INTO task_settlement (task_id, outcome, intent_tag, settled_routes_json, semantic_status, settled_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(task.id, task.state, intentTag, JSON.stringify(settledRoutes), semanticStatus, nowIso());
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
 * 语义结算 drain（coordinator reflectionTimer 挂钩；单进程串行 + 互斥，与反思 drain 同模式）。
 * 每次最多 maxPerTick 条；LLM 失败标 error 不重试（机会主义——结构化结算已完成主体）。
 * 返回本次处理条数。
 */
export async function drainSemanticSettlements(db: DB, maxPerTick = 2): Promise<number> {
  if (semanticDrainInFlight) return 0;
  semanticDrainInFlight = true;
  let processed = 0;
  try {
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
- route：抱怨针对的技能/方法 id（从上下文推断，如 document-authoring；推断不出为 null）
- 没有抱怨迹象时 complaintKind 为 null。宁可判 null，不可误判。`,
          user: `任务标题：${task.title}\n任务摘要：${task.summary.slice(0, 300)}\n加载技能：${resolvedSkillIdsOf(task).join(', ') || '无'}\n\n用户消息记录：\n${userText}`,
          tier: 'economy',
          timeoutMs: 30_000,
        });
        const parsed = parseSemanticComplaint(result.content);
        if (parsed.complaintKind && parsed.route && task.assigneeAgentId) {
          const profileId = getAgent(db, task.assigneeAgentId)?.profileId ?? null;
          if (profileId) {
            recordPreferenceEvent(db, {
              profileId,
              intentTag: classifyIntentTag(`${task.title} ${task.summary}`),
              route: parsed.route,
              source: 'user',
              kind: parsed.complaintKind,
              taskId,
            });
          }
        }
        db.prepare(`UPDATE task_settlement SET semantic_status = 'done' WHERE task_id = ?`).run(taskId);
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
