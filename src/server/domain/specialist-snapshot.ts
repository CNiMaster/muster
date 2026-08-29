/**
 * 常驻专家记忆快照（2026-08-24 蜂群分身专项）：蜂群命中常驻专家时不再借调真人，
 * 改为「分身穿戴」——建匿名蜂穿戴人设 + 注入本快照（只读薄手册：经验延续、不回写）。
 *
 * 数据源全为既有薄摘要（纯 DB 读、零 LLM 调用）：
 * - 人设方法论 top3（A7：persona_key 命中的 craft（CRAFT）记忆，按优势分排序——穿戴人设的
 *   分身最该带走的是"以这个人设怎么干活"，此前快照缺失此段只能靠注入链 craft 分支间接补）
 * - project_agent_thread.compaction_summary（上下文治理已维护的压缩摘要）
 * - 该专家最近 5 个已完成任务的一句话摘要
 * 硬预算 SNAPSHOT_MAX_CHARS：超出截断（方法论/经验摘要保底、任务列表次之）——
 * 快照太厚会让同 persona 多分身思维趋同，削弱「上下文差异出不同见解」的分身价值。
 * 用完即焚：只落蜂任务 inputProtocol.memorySnapshot（随任务归档走清理管道），不进任何记忆库；
 * 下次放群从常驻专家线程现读现拼（记忆更新则快照更新）。
 */
import type { DB } from '../db/client';

export const SNAPSHOT_MAX_CHARS = 1200;
/** 方法论段条数与单条截断（A7；批次 G 放宽）：top5、每条 160 字——craft 产能上来后多带一点，
 * 仍设上限尊重「快照太厚 → 同 persona 分身思维趋同」的防趋同设计（只放大不放开）。 */
const CRAFT_TOP_N = 5;
const CRAFT_LINE_MAX = 160;

export interface SpecialistSnapshot {
  /** null = 常驻专家尚无可聚合的记忆（无 thread / 无摘要无任务）——分身退化为纯人设穿戴，不阻断。 */
  snapshot: string | null;
  sourceThreadId: string | null;
}

export function buildSpecialistSnapshot(db: DB, agentId: string, personaId?: string | null): SpecialistSnapshot {
  const thread = db
    .prepare("SELECT id, compaction_summary FROM project_agent_thread WHERE agent_id=? AND kind='primary' LIMIT 1")
    .get(agentId) as { id: string; compaction_summary: string | null } | undefined;
  if (!thread) return { snapshot: null, sourceThreadId: null };

  const parts: string[] = [];
  // A7 人设方法论（最优先——穿戴人设的分身最先该带走"怎么干这类活"）
  if (personaId) {
    const crafts = db.prepare(
      `SELECT content FROM memory_entry
       WHERE scope='craft' AND persona_key=? AND state IN ('active','locked') AND can_influence=1
       ORDER BY adv_sum * 1.0 / (vote_count + 5) DESC, updated_at DESC LIMIT ?`,
    ).all(personaId, CRAFT_TOP_N) as Array<{ content: string }>;
    if (crafts.length > 0) {
      parts.push(`【人设方法论】\n${crafts.map((c) => `- ${c.content.slice(0, CRAFT_LINE_MAX)}`).join('\n')}`);
    }
  }
  const summary = thread.compaction_summary?.trim();
  if (summary) parts.push(`【经验摘要】\n${summary}`);
  const tasks = db
    .prepare(
      "SELECT title, summary FROM task WHERE assignee_agent_id=? AND state='completed' AND summary IS NOT NULL ORDER BY updated_at DESC LIMIT 5",
    )
    .all(agentId) as Array<{ title: string; summary: string }>;
  if (tasks.length > 0) {
    parts.push(`【最近完成】\n${tasks.map((t) => `- ${t.title}：${t.summary}`).join('\n')}`);
  }
  if (parts.length === 0) return { snapshot: null, sourceThreadId: thread.id };

  let snapshot = parts.join('\n\n');
  if (snapshot.length > SNAPSHOT_MAX_CHARS) snapshot = `${snapshot.slice(0, SNAPSHOT_MAX_CHARS)}…`;
  return { snapshot, sourceThreadId: thread.id };
}
