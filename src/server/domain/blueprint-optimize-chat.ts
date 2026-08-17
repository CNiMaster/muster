/**
 * 蓝图独立优化对话（2026-08-17 定案：退役「整体体检/consult」，改为每蓝图一个 AI 优化会话页）。
 *
 * 用户围绕单蓝图与 AI 沟通 → AI 回复 + 结构化提案 → 提案落 blueprint_optimization_item（pending，
 * 幂等）→ 采纳/忽略沿用 blueprint-optimizer 的版本化落地。LLM 不可用时降级为单蓝图确定性规则建议。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { log } from '../logger';
import { getBlueprintDetail, listBlueprints } from './blueprint';
import { callLlm } from './llm-call';
import {
  insertPendingOptimizationItem,
  listOptimizationItems,
  scoreOfBlueprint,
  type BlueprintOptimizationActionType,
  type BlueprintOptimizationItem,
} from './blueprint-optimizer';

export interface OptimizeChatMessage {
  id: string;
  blueprintId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface OptimizeChatTurn {
  messages: OptimizeChatMessage[];
  newProposals: BlueprintOptimizationItem[];
  pendingItems: BlueprintOptimizationItem[];
  source: 'llm' | 'rules';
}

interface ChatProposalDraft {
  actionType: BlueprintOptimizationActionType;
  targetBlueprintId?: string;
  reason?: string;
  expectedEffect?: string;
  params?: Record<string, unknown>;
}

const VALID_ACTIONS: BlueprintOptimizationActionType[] = ['lock', 'retire', 'merge', 'polish_description'];

function listChatRows(db: DB, blueprintId: string): OptimizeChatMessage[] {
  const rows = db.prepare(
    'SELECT * FROM blueprint_optimize_chat WHERE blueprint_id=? ORDER BY created_at, id',
  ).all(blueprintId) as Array<{ id: string; blueprint_id: string; role: string; content: string; created_at: string }>;
  return rows.map((r) => ({ id: r.id, blueprintId: r.blueprint_id, role: r.role as 'user' | 'assistant', content: r.content, createdAt: r.created_at }));
}

export function listOptimizeChat(db: DB, blueprintId: string): OptimizeChatMessage[] {
  return listChatRows(db, blueprintId);
}

function insertChatMessage(db: DB, blueprintId: string, role: 'user' | 'assistant', content: string): void {
  db.prepare(
    'INSERT INTO blueprint_optimize_chat (id, blueprint_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(shortId('boc_'), blueprintId, role, content, nowIso());
}

/** 单蓝图现状摘要（喂给 LLM 的核心上下文）。 */
function blueprintDigest(db: DB, companyId: string, blueprintId: string): string {
  const detail = getBlueprintDetail(db, blueprintId);
  const staffing = detail.staffingWithActiveTalents
    .map((s) => `${s.personaName}${s.activeUserTalent ? `（自有人才「${s.activeUserTalent.displayName}」在岗顶替）` : ''}`)
    .join('、');
  const lines = [
    `蓝图「${detail.label}」(id=${detail.id}, 业务分类=${detail.taskType}, 状态=${detail.status})`,
    `战绩：${detail.wins} 胜 ${detail.losses} 负，返工 ${detail.reworkTotal} 次，纠正 ${detail.correctionTotal} 次，综合评分 ${detail.score.score ?? '观察中(样本<3)'}`,
    `班底：${staffing || '无'}`,
    `常用工具：${detail.tools.map((t) => `${t.id}(用${t.uses}次)`).join('、') || '无'}`,
    `当前描述：${detail.description || '（空）'}`,
    `版本数：${detail.versions.length}（最近：${detail.versions.slice(0, 3).map((v) => v.summary).join('；') || '无'}）`,
  ];
  // 合并候选：其他现役蓝图（LLM 提 merge 时 targetBlueprintId 必须从这里选）
  const others = listBlueprints(db, companyId)
    .filter((bp) => bp.id !== blueprintId && bp.status !== 'retired')
    .slice(0, 8)
    .map((bp) => `「${bp.label}」(id=${bp.id}, 评分${scoreOfBlueprint(bp) ?? '观察中'})`);
  if (others.length > 0) lines.push(`可合并目标候选：${others.join('；')}`);
  return lines.join('\n');
}

/** LLM 不可用时的单蓝图确定性规则建议（对齐旧规则引擎中适用于单蓝图的部分）。 */
function ruleFallbackProposals(detail: ReturnType<typeof getBlueprintDetail>): Array<Omit<BlueprintOptimizationItem, 'id' | 'companyId' | 'status' | 'createdAt'>> {
  const total = detail.wins + detail.losses;
  const score = detail.score.score;
  const out: Array<Omit<BlueprintOptimizationItem, 'id' | 'companyId' | 'status' | 'createdAt'>> = [];
  if (total >= 5 && score !== null && score >= 80 && detail.status === 'active') {
    out.push({
      blueprintId: detail.id, actionType: 'lock', targetBlueprintId: null,
      reason: `综合评分 ${score} 且样本充足（${total} 次），打法已被验证`,
      expectedEffect: '锁定后不再被自动进化修改，稳定复用该打法', params: {},
    });
  }
  if (total >= 5 && score !== null && score < 30) {
    out.push({
      blueprintId: detail.id, actionType: 'retire', targetBlueprintId: null,
      reason: `综合评分仅 ${score}（${total} 次样本），长期表现不佳`,
      expectedEffect: '不再参与匹配；同类新证据出现时自动复活', params: {},
    });
  }
  if (!detail.description || detail.description.length < 20) {
    const topTools = detail.tools.slice(0, 3).map((t) => t.id).join('、');
    const template = `用于「${detail.taskType.split('|').slice(0, 6).join(' ')}」这类工作：主用人设「${detail.staffing[0]?.personaName ?? '待定'}」，${detail.wins} 胜 ${detail.losses} 负${topTools ? `，常用工具 ${topTools}` : ''}。打法随使用持续进化。`.slice(0, 400);
    out.push({
      blueprintId: detail.id, actionType: 'polish_description', targetBlueprintId: null,
      reason: '缺少用户语言描述',
      expectedEffect: '以模板生成一段清晰描述（可编辑）', params: { description: template },
    });
  }
  return out;
}

function parseLlmProposals(raw: string, blueprintId: string, validTargets: Set<string>): { reply: string; proposals: Array<Omit<BlueprintOptimizationItem, 'id' | 'companyId' | 'status' | 'createdAt'>> } {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: { reply?: unknown; proposals?: unknown };
  try {
    parsed = JSON.parse(text) as { reply?: unknown; proposals?: unknown };
  } catch {
    return { reply: raw.trim().slice(0, 2000), proposals: [] };
  }
  const reply = typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : '（AI 未给出文字说明，请看下方提案）';
  const proposals: Array<Omit<BlueprintOptimizationItem, 'id' | 'companyId' | 'status' | 'createdAt'>> = [];
  if (Array.isArray(parsed.proposals)) {
    for (const entry of parsed.proposals.slice(0, 5)) {
      const p = entry as ChatProposalDraft;
      if (!p || !VALID_ACTIONS.includes(p.actionType)) continue;
      if (p.actionType === 'merge' && (!p.targetBlueprintId || p.targetBlueprintId === blueprintId || !validTargets.has(p.targetBlueprintId))) continue;
      if (p.actionType === 'polish_description' && typeof p.params?.description !== 'string') continue;
      proposals.push({
        blueprintId,
        actionType: p.actionType,
        targetBlueprintId: p.actionType === 'merge' ? p.targetBlueprintId ?? null : null,
        reason: String(p.reason ?? '').slice(0, 500),
        expectedEffect: String(p.expectedEffect ?? '').slice(0, 500),
        params: p.actionType === 'polish_description' ? { description: String(p.params?.description).slice(0, 500) } : {},
      });
    }
  }
  return { reply, proposals };
}

/**
 * 发送一条优化对话消息：落用户消息 → LLM（premium 档，失败降级单蓝图规则）→
 * 回复与提案同事务落库（提案幂等）。返回全量会话与待处理提案。
 */
export async function sendOptimizeChatMessage(
  db: DB,
  companyId: string,
  blueprintId: string,
  userMessage: string,
): Promise<OptimizeChatTurn> {
  const detail = getBlueprintDetail(db, blueprintId);
  const history = listChatRows(db, blueprintId).slice(-20);
  const pending = listOptimizationItems(db, companyId, blueprintId).filter((i) => i.status === 'pending');
  const validTargets = new Set(
    listBlueprints(db, companyId).filter((bp) => bp.id !== blueprintId && bp.status !== 'retired').map((bp) => bp.id),
  );

  const system = [
    '你是 muster 工作台的「单蓝图优化顾问」。用户围绕下面这一张蓝图（打法包=班底+工具+描述+战绩的集合体）与你沟通，你负责诊断并给出可执行的优化提案。',
    '提案动作只能是四种：lock（锁定，冻结自动进化）、retire（淘汰，不再参与匹配）、merge（并入另一张蓝图，必须给 targetBlueprintId 且只能从「可合并目标候选」里选）、polish_description（params.description 给出新的用户语言描述）。',
    '没有值得做的动作就给空数组，绝不为了凑数而建议；同一动作如果已在待处理提案里就不要重复提。',
    '只输出一个 JSON 对象（不要代码围栏）：{"reply":"给用户看的中文说明，讲清你打算怎么优化、为什么","proposals":[{"actionType":"...","targetBlueprintId":"merge 时必填","reason":"依据","expectedEffect":"预期效果","params":{"description":"polish_description 时必填"}}]}',
  ].join('\n');
  const user = [
    `【蓝图现状】\n${blueprintDigest(db, companyId, blueprintId)}`,
    pending.length > 0 ? `【已有待处理提案】\n${pending.map((p) => `- ${p.actionType}${p.targetBlueprintId ? `→${p.targetBlueprintId}` : ''}：${p.reason}`).join('\n')}` : '【已有待处理提案】无',
    history.length > 0 ? `【对话历史】\n${history.map((m) => `${m.role === 'user' ? '用户' : '顾问'}：${m.content.slice(0, 500)}`).join('\n')}` : '【对话历史】（首轮）',
    `【用户本条消息】\n${userMessage}`,
  ].join('\n\n');

  let reply: string;
  let proposals: Array<Omit<BlueprintOptimizationItem, 'id' | 'companyId' | 'status' | 'createdAt'>>;
  let source: 'llm' | 'rules' = 'llm';
  try {
    const llm = await callLlm(db, { system, user, companyId, tier: 'premium', timeoutMs: 90_000 });
    const parsed = parseLlmProposals(llm.content, blueprintId, validTargets);
    reply = parsed.reply;
    proposals = parsed.proposals;
  } catch (e) {
    log.warn('blueprint optimize chat LLM failed; fallback to rules', { blueprintId, err: e instanceof Error ? e.message : String(e) });
    proposals = ruleFallbackProposals(detail);
    reply = proposals.length > 0
      ? 'LLM 暂不可用，先按确定性规则给出这张蓝图的建议（配置 LLM 凭据后可继续对话式优化）：'
      : 'LLM 暂不可用，且这张蓝图当前没有触发明确定性规则（评分锁定/低分淘汰/补描述）。请在凭据中心配置 LLM 后再试。';
    source = 'rules';
  }

  const newProposals: BlueprintOptimizationItem[] = [];
  db.transaction(() => {
    insertChatMessage(db, blueprintId, 'user', userMessage.slice(0, 4000));
    insertChatMessage(db, blueprintId, 'assistant', reply);
    for (const p of proposals) {
      if (insertPendingOptimizationItem(db, companyId, p)) {
        newProposals.push(...listOptimizationItems(db, companyId, blueprintId)
          .filter((i) => i.status === 'pending' && i.actionType === p.actionType && i.blueprintId === p.blueprintId)
          .slice(0, 1));
      }
    }
  })();

  return {
    messages: listChatRows(db, blueprintId),
    newProposals,
    pendingItems: listOptimizationItems(db, companyId, blueprintId).filter((i) => i.status === 'pending'),
    source,
  };
}
