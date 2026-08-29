/**
 * 蓝图独立优化对话（2026-08-17 定案：退役「整体体检/consult」，改为每蓝图一个 AI 优化会话页；
 * 2026-08-29 批次③重定调：AI 编辑助手=用户意图驱动——用户说想改什么，AI 负责知道哪些能改、
 * 怎么改、改了不坏，只动用户指定这一张蓝图；不主动推销治理提案凑数）。
 *
 * 用户围绕单蓝图与 AI 沟通 → AI 回复 + 结构化提案 → 提案落 blueprint_optimization_item（pending，
 * 幂等）→ 采纳/忽略沿用 blueprint-optimizer 的版本化落地（结构类动作落地前过校验，改坏即拒）。
 * LLM 不可用时降级为单蓝图确定性规则建议（仅治理/文案类——结构编辑必须听用户意图，不猜）。
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
  staffingProposalSchema,
  type BlueprintOptimizationActionType,
  type BlueprintOptimizationItem,
} from './blueprint-optimizer';
import { blueprintStagesSchema, coerceBlueprintStages, describeStages } from '../../shared/blueprint-stages';
import { listPersonas } from './persona-library';

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

const VALID_ACTIONS: BlueprintOptimizationActionType[] = [
  'lock', 'retire', 'merge', 'polish_description', 'adjust_staffing', 'update_stages', 'rename_blueprint',
];

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
    .map((s) => `${s.personaName}<${s.personaId}>${s.role ? `（${s.role}）` : ''}${s.activeUserTalent ? `（自有人才「${s.activeUserTalent.displayName}」在岗顶替）` : ''}`)
    .join('、');
  const stages = coerceBlueprintStages(detail.stages);
  const stageBindings = stages.map((st) => {
    const who = (st.staffingPersonaIds ?? []).join('、');
    const kit = (st.tools ?? []).map((t) => `${t.kind}:${t.id}`).join('、');
    const gate = st.gate && st.gate !== 'none' ? `门=${st.gate}` : '';
    return `${st.label}[${[who || '主槽', kit || '无指定工具', gate].filter(Boolean).join(' | ')}]`;
  }).join('；');
  const lines = [
    `蓝图「${detail.label}」(id=${detail.id}, 业务分类=${detail.taskType}, 状态=${detail.status})`,
    `战绩：${detail.wins} 胜 ${detail.losses} 负，返工 ${detail.reworkTotal} 次，纠正 ${detail.correctionTotal} 次，综合评分 ${detail.score.score ?? '观察中(样本<3)'}`,
    `班底：${staffing || '无'}`,
    `阶段工作流：${stages.length > 0 ? describeStages(stages) : '未定义（用户想拆阶段时可建议 update_stages）'}`,
    ...(stageBindings ? [`阶段绑定详情（谁上/用什么/门）：${stageBindings}`] : []),
    `常用工具：${detail.tools.map((t) => `${t.id}(用${t.uses}次)`).join('、') || '无'}`,
    `当前描述：${detail.description || '（空）'}`,
    `版本数：${detail.versions.length}（最近：${detail.versions.slice(0, 3).map((v) => v.summary).join('；') || '无'}）`,
  ];
  // M2 批次B：阶段级统计（哪一步常返工/常被门拦）——结构类提案的数据依据
  try {
    const stats = db.prepare(
      'SELECT label, runs, reworks, gate_fails FROM blueprint_stage_stat WHERE blueprint_id=? ORDER BY reworks DESC, gate_fails DESC LIMIT 8',
    ).all(blueprintId) as Array<{ label: string; runs: number; reworks: number; gate_fails: number }>;
    if (stats.length > 0) {
      lines.push(`阶段统计（runs=经历任务数/返工=阶段内额外尝试/门败=质量门未过次数）：${stats.map((x) => `${x.label} ${x.runs}跑/${x.reworks}返工/${x.gate_fails}门败`).join('；')}`);
    }
  } catch { /* 统计缺失不影响对话 */ }
  // 人设名录（adjust_staffing 的 personaId 唯一合法来源——AI 不许虚构成员）
  const roster = listPersonas()
    .slice(0, 120)
    .map((p) => `${p.name}<${p.id}>`)
    .join('、');
  if (roster) lines.push(`人设名录（adjust_staffing 只能从这里选，主槽在前）：${roster}`);
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
      // 结构类提案在入库前就过契约门：载荷不合法直接丢条目（不落数据库），采纳侧还有第二道语义门。
      if (p.actionType === 'adjust_staffing') {
        const staffing = staffingProposalSchema.safeParse(p.params?.staffing);
        if (!staffing.success) continue;
        proposals.push({
          blueprintId,
          actionType: 'adjust_staffing',
          targetBlueprintId: null,
          reason: String(p.reason ?? '').slice(0, 500),
          expectedEffect: String(p.expectedEffect ?? '').slice(0, 500),
          params: { staffing: staffing.data },
        });
        continue;
      }
      if (p.actionType === 'rename_blueprint') {
        const label = typeof p.params?.label === 'string' ? p.params.label.trim() : '';
        if (!label || label.length > 40) continue;
        proposals.push({
          blueprintId,
          actionType: 'rename_blueprint',
          targetBlueprintId: null,
          reason: String(p.reason ?? '').slice(0, 500),
          expectedEffect: String(p.expectedEffect ?? '').slice(0, 500),
          params: { label },
        });
        continue;
      }
      if (p.actionType === 'update_stages') {
        const stages = blueprintStagesSchema.safeParse(p.params?.stages);
        if (!stages.success || stages.data.length === 0) continue;
        proposals.push({
          blueprintId,
          actionType: 'update_stages',
          targetBlueprintId: null,
          reason: String(p.reason ?? '').slice(0, 500),
          expectedEffect: String(p.expectedEffect ?? '').slice(0, 500),
          params: { stages: stages.data },
        });
        continue;
      }
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
    '你是 muster 工作台的「蓝图编辑助手」。用户围绕下面这一张蓝图（打法包 = 班底 + 阶段工作流 + 工具 + 描述 + 战绩的集合体）告诉你他想怎么改；你的职责是把用户的意图落成可执行的修改提案——你懂这张蓝图哪些能改、怎么改、怎么改不坏。',
    '提案动作七种：',
    '- adjust_staffing（调整班底）：params.staffing 给「完整的新班底」（1-4 槽，主槽/责任人放第一位）。personaId/personaName 只能从「人设名录」里照抄，绝不虚构、绝不改写 id。',
    '- update_stages（调整阶段工作流）：params.stages 给「完整的新阶段列表」（1-8 个，每个 {"id","step","label","description?"}，step 从 1 连续编号即执行顺序；需要分叉/跳步时用 "dependsOn":[前置阶段id]，禁止成环）。"staffingPersonaIds" 标注该阶段谁上（只能引用当前班底 personaId，第一个为主责、引擎按此换人）；"tools":[{"kind":"skill|tool|mcp","id":"..."}] 标注该阶段优先用什么（≤5 个）；"gate":"self-check|acceptance" 给关键阶段设质量门（缺省无门——门是可选项，只在错了会白干后面的阶段上用，用户明说要门才加）。',
    '- polish_description（润色描述）：params.description 给新的用户语言描述。',
    '- rename_blueprint（改名）：params.label 给一个更直观的新名字（4-12 个中文字为佳，职责显而易见，不带人设名前缀）——进化蓝图的自动拼名（人设名·标题片段）常不直观，用户说名字不好就提这个。',
    '- lock（锁定，冻结自动进化）/ retire（淘汰，退出匹配）：治理动作，战绩证据足够时才提。',
    '- merge（并入另一张蓝图）：必须给 targetBlueprintId，且只能从「可合并目标候选」里选——两张蓝图确实覆盖同一类活才提。',
    '原则：只改这一张蓝图；用户意图不清楚时先在 reply 里追问，不要硬给提案；结构类调整（班底/阶段）永远给完整目标值而不是只给增量；没有值得做的动作就给空数组，绝不凑数；同一动作已在待处理提案里就不要重复提。',
    '只输出一个 JSON 对象（不要代码围栏）：{"reply":"给用户看的中文说明：先确认你理解的意图，再讲打算怎么改、为什么","proposals":[{"actionType":"...","targetBlueprintId":"merge 时必填","reason":"依据","expectedEffect":"预期效果","params":{"staffing":"adjust_staffing 时必填","stages":"update_stages 时必填","description":"polish_description 时必填"}}]}',
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
