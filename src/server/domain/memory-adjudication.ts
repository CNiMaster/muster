/**
 * 记忆候选自动裁决（2026-08-29 记忆自动化批）：默认全自动、人不再是必经环节。
 *
 * 背景：低置信 LESSON/RULE/PREFERENCE/CRAFT 与 closeout 抽取产物此前落 pending 等记忆看板
 * 人工审——对小白用户等于永远没人审（不可信的为什么留着）。本模块把「人审」换成「独立裁决」：
 * economy LLM 以第三方视角（非作者自批——守 postmortem 自辩悖论边界）判 keep/drop，
 * keep 即生效、drop 即出局；LLM 不可用时留待下轮，超 TTL（7 天）兜底出局。
 * 看板保留为可选的人工干预面（功能提供，默认不需要人来管）。
 * 开关 memory_auto_adjudicate_enabled 默认开；关闭=回到全人工模式（TTL 也不清）。
 */
import type { DB } from '../db/client';
import { log } from '../logger';
import { getSetting } from './setting';
import { approveMemoryCandidate, rejectMemoryCandidate } from './memory';

/** 单轮最多裁决条数（随 reflection drain 10s 节拍摊销）。 */
const ADJUDICATE_MAX_PER_TICK = 3;
/** pending 兜底出局时限（天）：裁决多次失败/未跑的候选不给无限期占位。 */
export const PENDING_TTL_DAYS = 7;

export const MEMORY_AUTO_ADJUDICATE_SETTING = 'memory_auto_adjudicate_enabled';

export interface AdjudicateResult {
  kept: number;
  dropped: number;
  expired: number;
  skipped: number;
}

interface CandidateRow {
  id: string;
  scope: string;
  profile_id: string;
  project_id: string | null;
  persona_key: string | null;
  content: string;
  confidence: number;
  quarantine_reason: string | null;
  created_at: string;
}

/** 同分区既有生效记忆（裁决的查重参照）：personal 全局、craft 按人设、project 按项目、workspace 按 profile。 */
function partitionPeers(db: DB, c: CandidateRow): string[] {
  const where = c.scope === 'personal'
    ? "scope='personal'"
    : c.scope === 'craft'
      ? "scope='craft' AND persona_key IS ?"
      : c.scope === 'project'
        ? "scope='project' AND project_id IS ?"
        : "scope='workspace' AND profile_id=?";
  const arg = c.scope === 'craft' ? c.persona_key : c.scope === 'project' ? c.project_id : c.profile_id;
  const rows = db.prepare(
    `SELECT content FROM memory_entry WHERE state IN ('active','locked') AND can_influence=1 AND ${where}
     ORDER BY updated_at DESC LIMIT 5`,
  ).all(arg) as Array<{ content: string }>;
  return rows.map((r) => r.content.slice(0, 200));
}

export async function adjudicatePendingMemories(db: DB, opts?: { maxPerTick?: number }): Promise<AdjudicateResult> {
  const result: AdjudicateResult = { kept: 0, dropped: 0, expired: 0, skipped: 0 };
  if (getSetting(db, MEMORY_AUTO_ADJUDICATE_SETTING, 'true') !== 'true') return result;
  const maxPerTick = opts?.maxPerTick ?? ADJUDICATE_MAX_PER_TICK;

  // ① TTL 兜底出局：裁决长期没跑成（LLM 不可用等）的 pending 不给无限期占位。
  const ttlCutoff = new Date(Date.now() - PENDING_TTL_DAYS * 86_400_000).toISOString();
  const stale = db.prepare(
    `SELECT id FROM memory_candidate WHERE status='pending' AND quarantine_reason IS NULL AND created_at < ?`,
  ).all(ttlCutoff) as Array<{ id: string }>;
  for (const row of stale) {
    try {
      rejectMemoryCandidate(db, row.id, 'auto-ttl');
      result.expired += 1;
    } catch { /* 状态已变等竞态：跳过 */ }
  }

  // ② LLM 裁决最老的 pending（隔离候选除外——隔离必须用户亲自审，维持既有安全边界）。
  const { callLlm } = await import('./llm-call');
  const pending = db.prepare(
    `SELECT * FROM memory_candidate WHERE status='pending' AND quarantine_reason IS NULL ORDER BY created_at, id LIMIT ?`,
  ).all(maxPerTick) as CandidateRow[];
  for (const c of pending) {
    try {
      const peers = partitionPeers(db, c);
      const llm = await callLlm(db, {
        system: [
          '你是记忆库的独立裁决员。一条由 AI 执行体沉淀的候选记忆摆在面前，判断它该生效还是出局。',
          '判 keep 的标准：具体、可复用、对未来同类任务有正向影响，且与既有记忆不重复（是补充而非重复）。',
          '判 drop 的标准：空泛套话/一次性事实（只在本次任务成立）/与既有记忆高度重复/自相矛盾。',
          '拿不准判 drop（宁缺毋滥）。',
          '只输出一个 JSON 对象（不要代码围栏）：{"verdict":"keep"|"drop","reason":"一句话理由"}',
        ].join('\n'),
        user: [
          `候选记忆（scope=${c.scope}，置信度 ${c.confidence}）：`,
          c.content.slice(0, 500),
          peers.length > 0 ? `\n同分区既有相关记忆：\n${peers.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '\n（同分区暂无既有记忆）',
        ].join('\n'),
        timeoutMs: 20_000,
        tier: 'economy',
      });
      const jsonMatch = /\{[\s\S]*\}/.exec(llm.content.trim());
      if (!jsonMatch) { result.skipped += 1; continue; }
      const verdict = (JSON.parse(jsonMatch[0]) as { verdict?: unknown }).verdict;
      if (verdict === 'keep') {
        approveMemoryCandidate(db, c.id, 'auto-llm');
        result.kept += 1;
      } else if (verdict === 'drop') {
        rejectMemoryCandidate(db, c.id, 'auto-llm');
        result.dropped += 1;
      } else {
        result.skipped += 1;
      }
    } catch (e) {
      // fail-open：单条失败留待下轮（TTL 兜底），绝不阻断批次
      log.warn('memory adjudication skipped', { id: c.id, err: String(e) });
      result.skipped += 1;
    }
  }
  return result;
}
