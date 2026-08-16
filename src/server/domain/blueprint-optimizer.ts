/**
 * 蓝图深度优化（进化环收拢批次4，替代旧运营报告）。
 *
 * 手动按钮触发的按需体检：分析蓝图评分分布 + 班底/工具/描述现状 → 产出建议清单
 * （锁定高胜率 / 淘汰长期负 / 并合近重复 / 润色描述），逐条采纳落地——
 * 所有落地动作都走蓝图版本化提交，用户可回滚。LLM 不可用时降级确定性规则引擎。
 *
 * 动作域只作用于蓝图（组织 = f(活) 的正主），不再有加员工/调工作流类组织手术。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { log } from '../logger';
import { listBlueprints, setBlueprintStatus, updateBlueprintDescription, commitBlueprintVersion, getBlueprint, type Blueprint } from './blueprint';
import type { SetupGenerator } from './setup-assistant';

export type BlueprintOptimizationActionType = 'lock' | 'retire' | 'merge' | 'polish_description';

export interface BlueprintOptimizationItem {
  id: string;
  companyId: string;
  blueprintId: string;
  actionType: BlueprintOptimizationActionType;
  /** merge 的目标蓝图（并入谁）。 */
  targetBlueprintId: string | null;
  reason: string;
  expectedEffect: string;
  params: Record<string, unknown>;
  status: 'pending' | 'applied' | 'ignored';
  createdAt: string;
}

interface ItemRow {
  id: string; company_id: string; blueprint_id: string; action_type: string;
  target_blueprint_id: string | null; reason: string; expected_effect: string;
  params_json: string; status: string; created_at: string;
}

function fromRow(row: ItemRow): BlueprintOptimizationItem {
  return {
    id: row.id,
    companyId: row.company_id,
    blueprintId: row.blueprint_id,
    actionType: row.action_type as BlueprintOptimizationActionType,
    targetBlueprintId: row.target_blueprint_id,
    reason: row.reason,
    expectedEffect: row.expected_effect,
    params: JSON.parse(row.params_json ?? '{}') as Record<string, unknown>,
    status: row.status as BlueprintOptimizationItem['status'],
    createdAt: row.created_at,
  };
}

function insertItem(db: DB, companyId: string, item: Omit<BlueprintOptimizationItem, 'id' | 'companyId' | 'status' | 'createdAt'>): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO blueprint_optimization_item
      (id, company_id, blueprint_id, action_type, target_blueprint_id, reason, expected_effect, params_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(shortId('boi_'), companyId, item.blueprintId, item.actionType, item.targetBlueprintId ?? null,
    item.reason, item.expectedEffect, JSON.stringify(item.params ?? {}), now);
}

/** 多维评分（与面板一致）：胜率 60% + 低返工 25% + 低纠正 15%；样本 < 3 视为观察中。 */
function scoreOf(bp: Blueprint): number | null {
  const total = bp.wins + bp.losses;
  if (total < 3) return null;
  const winRate = bp.wins / total;
  const reworkRate = Math.min(1, bp.reworkTotal / total);
  const correctionRate = Math.min(1, bp.correctionTotal / total);
  return Math.round((winRate * 0.6 + (1 - reworkRate) * 0.25 + (1 - correctionRate) * 0.15) * 100);
}

/** 确定性规则引擎（LLM 不可用时的离线建议）。 */
function ruleBasedSuggestions(db: DB, companyId: string): Array<Omit<BlueprintOptimizationItem, 'id' | 'companyId' | 'status' | 'createdAt'>> {
  const blueprints = listBlueprints(db, companyId).filter((bp) => bp.status !== 'retired');
  const suggestions: Array<Omit<BlueprintOptimizationItem, 'id' | 'companyId' | 'status' | 'createdAt'>> = [];
  for (const bp of blueprints) {
    const total = bp.wins + bp.losses;
    const score = scoreOf(bp);
    if (total >= 5 && score !== null && score >= 80 && bp.status === 'active') {
      suggestions.push({
        blueprintId: bp.id, actionType: 'lock', targetBlueprintId: null,
        reason: `「${bp.label}」综合评分 ${score} 且样本充足（${total} 次），打法已被验证`,
        expectedEffect: '锁定后不再被自动进化修改，稳定复用该打法',
        params: {},
      });
    }
    if (total >= 5 && score !== null && score < 30) {
      suggestions.push({
        blueprintId: bp.id, actionType: 'retire', targetBlueprintId: null,
        reason: `「${bp.label}」综合评分仅 ${score}（${total} 次样本），长期表现不佳`,
        expectedEffect: '不再参与匹配；同类新证据出现时自动复活',
        params: {},
      });
    }
    if (!bp.description || bp.description.length < 20) {
      const topTools = bp.tools.slice(0, 3).map((t) => t.id).join('、');
      const template = `用于「${bp.taskType.split('|').slice(0, 6).join(' ')}」这类工作：主用人设「${bp.staffing[0]?.personaName ?? '待定'}」，${bp.wins} 胜 ${bp.losses} 负${topTools ? `，常用工具 ${topTools}` : ''}。打法随使用持续进化。`.slice(0, 400);
      suggestions.push({
        blueprintId: bp.id, actionType: 'polish_description', targetBlueprintId: null,
        reason: `「${bp.label}」缺少用户语言描述`,
        expectedEffect: '以模板生成一段清晰描述（可编辑），便于观察与追溯',
        params: { description: template },
      });
    }
  }
  // 近重复合并：两两 Jaccard 在 [0.1, 0.4) 区间（低于并合阈值所以未自动合并，
  // 但词面重叠明显——经常抢同一批任务；taskType 是 n-gram 展开集，0.1 ≈ 共享约 2 个词）
  for (let i = 0; i < blueprints.length; i++) {
    for (let j = i + 1; j < blueprints.length; j++) {
      const a = blueprints[i]!;
      const b = blueprints[j]!;
      const tokensA = a.taskType.split('|').filter(Boolean);
      const tokensB = b.taskType.split('|').filter(Boolean);
      const inter = tokensA.filter((t) => tokensB.includes(t)).length;
      if (inter === 0) continue;
      const jaccard = inter / (tokensA.length + tokensB.length - inter);
      if (jaccard >= 0.1 && jaccard < 0.4) {
        suggestions.push({
          blueprintId: b.id, actionType: 'merge', targetBlueprintId: a.id,
          reason: `「${b.label}」与「${a.label}」词元相似度 ${Math.round(jaccard * 100)}%，覆盖同一类活`,
          expectedEffect: '班底/工具/战绩合并为一张蓝图，另一张退役（可回滚）',
          params: {},
        });
      }
    }
  }
  return suggestions;
}

/** 生成本轮深度优化建议（幂等：同蓝图同动作的 pending 建议不重复生成）。 */
export async function generateBlueprintOptimization(
  db: DB,
  companyId: string,
  options: { generator?: SetupGenerator } = {},
): Promise<{ source: 'claude' | 'rules'; items: BlueprintOptimizationItem[] }> {
  const blueprints = listBlueprints(db, companyId).filter((bp) => bp.status !== 'retired');
  let suggestions: Array<Omit<BlueprintOptimizationItem, 'id' | 'companyId' | 'status' | 'createdAt'>> = [];
  let source: 'claude' | 'rules' = 'rules';

  if (options.generator) {
    try {
      const digest = blueprints.map((bp) => {
        const score = scoreOf(bp);
        return `- 蓝图「${bp.label}」(状态${bp.status}, 样本${bp.wins + bp.losses}, 评分${score ?? '观察中'}, 返工${bp.reworkTotal}, 纠正${bp.correctionTotal}, 班底[${bp.staffing.map((s) => s.personaName).join(',')}], 工具[${bp.tools.map((t) => t.id).join(',')}], 描述「${(bp.description || '').slice(0, 60)}」)`;
      }).join('\n');
      const generated = await options.generator.generate({
        prompt: `你是工作台的打法优化顾问。基于以下蓝图（打法包）体检数据，给出最值得做的 3-8 条优化建议。动作只能是：lock（锁定高胜率打法）、retire（淘汰长期负）、merge（合并近重复蓝图到 targetBlueprintId）、polish_description（params 带新 description 文本）。每张蓝图最多 2 条建议，不要为了凑数而建议；没有明显问题就不要建议。\n\n蓝图数据：\n${digest}\n\n输出 JSON 数组，每项：{blueprintId, actionType, targetBlueprintId?, reason, expectedEffect, params?}。`,
        jsonSchema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              blueprintId: { type: 'string' },
              actionType: { type: 'string', enum: ['lock', 'retire', 'merge', 'polish_description'] },
              targetBlueprintId: { type: 'string' },
              reason: { type: 'string' },
              expectedEffect: { type: 'string' },
              params: { type: 'object' },
            },
            required: ['blueprintId', 'actionType', 'reason', 'expectedEffect'],
            additionalProperties: false,
          },
        },
      });
      const raw = Array.isArray(generated) ? generated : [];
      for (const entry of raw) {
        const bp = blueprints.find((b) => b.id === entry.blueprintId);
        if (!bp) continue;
        const actionType = ['lock', 'retire', 'merge', 'polish_description'].includes(entry.actionType)
          ? entry.actionType as BlueprintOptimizationActionType
          : null;
        if (!actionType) continue;
        if (actionType === 'merge' && (!entry.targetBlueprintId || entry.targetBlueprintId === entry.blueprintId || !blueprints.some((b) => b.id === entry.targetBlueprintId))) continue;
        suggestions.push({
          blueprintId: bp.id,
          actionType,
          targetBlueprintId: actionType === 'merge' ? entry.targetBlueprintId ?? null : null,
          reason: String(entry.reason ?? ''),
          expectedEffect: String(entry.expectedEffect ?? ''),
          params: actionType === 'polish_description' && typeof entry.params?.description === 'string'
            ? { description: entry.params.description }
            : {},
        });
      }
      if (suggestions.length > 0) source = 'claude';
    } catch (error) {
      log.warn('blueprint optimization AI failed; using rules', { companyId, error: error instanceof Error ? error.message : String(error) });
      suggestions = [];
    }
  }
  if (suggestions.length === 0) {
    suggestions = ruleBasedSuggestions(db, companyId);
  }

  // 幂等写入：同蓝图同动作的 pending 建议跳过
  for (const suggestion of suggestions) {
    const exists = db.prepare(
      `SELECT 1 FROM blueprint_optimization_item
        WHERE company_id=? AND blueprint_id=? AND action_type=? AND status='pending' LIMIT 1`,
    ).get(companyId, suggestion.blueprintId, suggestion.actionType);
    if (!exists) insertItem(db, companyId, suggestion);
  }
  return { source, items: listOptimizationItems(db, companyId) };
}

export function listOptimizationItems(db: DB, companyId: string): BlueprintOptimizationItem[] {
  const rows = db.prepare(
    'SELECT * FROM blueprint_optimization_item WHERE company_id=? ORDER BY created_at DESC',
  ).all(companyId) as ItemRow[];
  return rows.map(fromRow);
}

/** 采纳建议：按动作落地（全部走版本化提交）。返回落地结果。 */
export function applyOptimizationItem(db: DB, itemId: string): { applied: boolean; message: string } {
  const row = db.prepare('SELECT * FROM blueprint_optimization_item WHERE id=?').get(itemId) as ItemRow | undefined;
  if (!row) throw new Error('优化建议不存在');
  if (row.status !== 'pending') return { applied: false, message: '该建议已处理' };
  const item = fromRow(row);
  let message = '';
  // 断电安全：动作落地 + 建议状态同事务（嵌套事务自动落 savepoint）——崩溃不会出现"已改蓝图但建议仍 pending"导致的重复采纳
  const applied = db.transaction((): boolean => {
    switch (item.actionType) {
      case 'lock':
        setBlueprintStatus(db, item.blueprintId, 'locked');
        message = '已锁定（冻结进化，仍参与匹配）';
        return true;
      case 'retire':
        setBlueprintStatus(db, item.blueprintId, 'retired');
        message = '已淘汰（不再参与匹配）';
        return true;
      case 'merge': {
        if (!item.targetBlueprintId) { message = '合并缺少目标蓝图'; return false; }
        if (item.targetBlueprintId === item.blueprintId) { message = '不能合并到自身'; return false; }
        const target = getBlueprint(db, item.targetBlueprintId);
        const source = getBlueprint(db, item.blueprintId);
        // 班底并集（≤4 槽）、工具并集（cap 10）、战绩相加
        const staffing = [...target.staffing];
        for (const slot of source.staffing) {
          if (!staffing.some((s) => s.personaId === slot.personaId) && staffing.length < 4) staffing.push(slot);
        }
        const tools = [...target.tools];
        for (const tool of source.tools) {
          const hit = tools.find((t) => t.kind === tool.kind && t.id === tool.id);
          if (hit) { hit.uses += tool.uses; hit.wins += tool.wins; }
          else if (tools.length < 10) tools.push({ ...tool });
        }
        const now = nowIso();
        db.prepare(
          `UPDATE blueprint SET staffing_json=?, tools_json=?,
             wins=?, losses=?, rework_total=?, correction_total=?, updated_at=? WHERE id=?`,
        ).run(
          JSON.stringify(staffing), JSON.stringify(tools),
          target.wins + source.wins, target.losses + source.losses,
          target.reworkTotal + source.reworkTotal, target.correctionTotal + source.correctionTotal,
          now, target.id,
        );
        commitBlueprintVersion(db, target.id, `合并：吸收「${source.label}」的班底/工具/战绩`, [source.id]);
        setBlueprintStatus(db, source.id, 'retired');
        message = `已合并进「${target.label}」，源蓝图退役（可回滚）`;
        return true;
      }
      case 'polish_description': {
        const description = typeof item.params.description === 'string' ? item.params.description.trim() : '';
        if (!description) { message = '建议缺少描述文本'; return false; }
        updateBlueprintDescription(db, item.blueprintId, description);
        message = '描述已更新';
        return true;
      }
    }
  })();
  if (applied) {
    db.prepare("UPDATE blueprint_optimization_item SET status='applied' WHERE id=?").run(itemId);
  }
  return { applied, message };
}

export function ignoreOptimizationItem(db: DB, itemId: string): void {
  db.prepare("UPDATE blueprint_optimization_item SET status='ignored' WHERE id=?").run(itemId);
}
