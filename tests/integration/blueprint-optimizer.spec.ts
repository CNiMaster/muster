/**
 * 蓝图优化对话与提案落地（2026-08-17 重构：公司级一键体检退役，改为每蓝图独立优化对话）：
 * - 对话链路：LLM 不可用时降级单蓝图确定性规则（锁定/淘汰/润色），会话消息与提案同事务落库
 * - 提案幂等：同蓝图同动作 pending 不重复插入
 * - 采纳落地走版本化：锁定/淘汰/合并/描述各自出版；合并后源蓝图退役；忽略后不再可采纳
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createNovelCompany } from './setup';
import { createProject } from '../../src/server/domain/project';
import { evolveBlueprint, listBlueprintVersions, getBlueprint } from '../../src/server/domain/blueprint';
import { sendOptimizeChatMessage, listOptimizeChat } from '../../src/server/domain/blueprint-optimize-chat';
import {
  insertPendingOptimizationItem, listOptimizationItems, applyOptimizationItem, ignoreOptimizationItem,
} from '../../src/server/domain/blueprint-optimizer';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;
let projectId: string;

function seedBlueprint(title: string, personaId: string, personaName: string, win: boolean, rework = 0, corrections = 0): string {
  const bp = evolveBlueprint(db, { companyId, projectId, taskTitle: title, personaId, personaName, win, reworkCount: rework, correctionCount: corrections });
  return bp.id;
}

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  companyId = r.company.id;
  const project = createProject(db, { companyId, name: 'p', rootDir: '/tmp/bpo', firstAgentId: r.agents.lead.id, initialState: 'active' });
  projectId = project.id;
});

describe('blueprint optimize chat & proposals', () => {
  it('对话降级规则：高胜率→锁定；低评分→淘汰；会话消息与提案同事务落库且幂等', async () => {
    // 高胜率：5 次全胜无返工无纠正
    const good = seedBlueprint('制作产品发布会 PPT', 'p_writer', '笔杆子', true);
    for (let i = 1; i < 5; i++) {
      evolveBlueprint(db, { companyId, projectId, taskTitle: `制作产品发布会 PPT 第${i}稿`, personaId: 'p_writer', personaName: '笔杆子', win: true });
    }
    // 低评分：5 次全败 + 返工
    const bad = seedBlueprint('运营周报数据统计', 'p_analyst', '分析员', false, 3, 2);
    for (let i = 1; i < 5; i++) {
      evolveBlueprint(db, { companyId, projectId, taskTitle: `运营周报数据统计 第${i}轮`, personaId: 'p_analyst', personaName: '分析员', win: false, reworkCount: 2, correctionCount: 1 });
    }

    const turn1 = await sendOptimizeChatMessage(db, companyId, good, '这套打法表现怎么样？要不要锁定？');
    expect(turn1.source).toBe('rules'); // 测试库无 LLM 凭据 → 降级
    expect(turn1.messages.length).toBe(2); // 用户 + AI 各一条
    expect(turn1.newProposals.some((i) => i.blueprintId === good && i.actionType === 'lock')).toBe(true);

    const turn2 = await sendOptimizeChatMessage(db, companyId, bad, '最近老输，还有救吗？');
    expect(turn2.newProposals.some((i) => i.blueprintId === bad && i.actionType === 'retire')).toBe(true);

    // 幂等：再聊一轮不重复插入同动作提案
    const turn3 = await sendOptimizeChatMessage(db, companyId, good, '再看看还有什么可做的');
    expect(turn3.pendingItems.filter((i) => i.blueprintId === good && i.actionType === 'lock').length).toBe(1);
    // 会话历史按序累积
    expect(listOptimizeChat(db, good).length).toBe(4);
  });

  it('采纳锁定/润色：落地并出版版本；忽略后不再可采纳', async () => {
    const good = seedBlueprint('制作产品发布会 PPT', 'p_writer', '笔杆子', true);
    for (let i = 1; i < 5; i++) {
      evolveBlueprint(db, { companyId, projectId, taskTitle: `制作产品发布会 PPT 第${i}稿`, personaId: 'p_writer', personaName: '笔杆子', win: true });
    }
    // 模拟对话产出的提案（LLM 路径等价物）：直接经同一落库函数
    expect(insertPendingOptimizationItem(db, companyId, {
      blueprintId: good, actionType: 'lock', targetBlueprintId: null,
      reason: '高胜率被验证', expectedEffect: '冻结自动进化', params: {},
    })).toBe(true);
    db.prepare("UPDATE blueprint SET description='' WHERE id=?").run(good);
    expect(insertPendingOptimizationItem(db, companyId, {
      blueprintId: good, actionType: 'polish_description', targetBlueprintId: null,
      reason: '缺描述', expectedEffect: '补模板描述', params: { description: '用于「制作 产品 发布会 PPT」这类工作：主用人设「笔杆子」，5 胜 0 负。打法随使用持续进化。' },
    })).toBe(true);

    const before = listBlueprintVersions(db, good).length;
    const lockItem = listOptimizationItems(db, companyId, good).find((i) => i.actionType === 'lock')!;
    const lockResult = applyOptimizationItem(db, lockItem.id);
    expect(lockResult.applied).toBe(true);
    expect(getBlueprint(db, good).status).toBe('locked');
    expect(listBlueprintVersions(db, good).length).toBe(before + 1);
    expect(listBlueprintVersions(db, good)[0]!.summary).toContain('锁定');

    const polishItem = listOptimizationItems(db, companyId, good).find((i) => i.actionType === 'polish_description')!;
    const polishResult = applyOptimizationItem(db, polishItem.id);
    expect(polishResult.applied).toBe(true);
    expect(getBlueprint(db, good).description.length).toBeGreaterThan(10);
    expect(listBlueprintVersions(db, good).some((v) => v.summary.includes('描述更新'))).toBe(true);

    // 忽略路径：忽略后不可再采纳
    expect(insertPendingOptimizationItem(db, companyId, {
      blueprintId: good, actionType: 'retire', targetBlueprintId: null,
      reason: '测试忽略', expectedEffect: '无', params: {},
    })).toBe(true);
    const retireItem = listOptimizationItems(db, companyId, good).find((i) => i.actionType === 'retire' && i.status === 'pending')!;
    ignoreOptimizationItem(db, retireItem.id);
    expect(listOptimizationItems(db, companyId, good).find((i) => i.id === retireItem.id)!.status).toBe('ignored');
    expect(applyOptimizationItem(db, retireItem.id).applied).toBe(false);
  });

  it('采纳合并：班底/战绩相加、源蓝图退役、目标出版', async () => {
    // 两张覆盖同类活但未自动合并的蓝图，经对话产出合并提案（直接经同一落库函数）
    const a = seedBlueprint('行业调研报告撰写', 'p_writer', '笔杆子', true);
    evolveBlueprint(db, { companyId, projectId, taskTitle: '行业调研报告撰写 初稿', personaId: 'p_writer', personaName: '笔杆子', win: true, reworkCount: 1 });
    const b = seedBlueprint('行业调研排版整理', 'p_researcher', '研究员', true);
    evolveBlueprint(db, { companyId, projectId, taskTitle: '行业调研排版整理 汇编', personaId: 'p_researcher', personaName: '研究员', win: false, tools: ['web_fetch'] });

    expect(insertPendingOptimizationItem(db, companyId, {
      blueprintId: b, actionType: 'merge', targetBlueprintId: a,
      reason: '覆盖同一类活', expectedEffect: '合并为一张蓝图', params: {},
    })).toBe(true);
    const mergeItem = listOptimizationItems(db, companyId, b).find((i) => i.actionType === 'merge')!;

    const result = applyOptimizationItem(db, mergeItem.id);
    expect(result.applied).toBe(true);
    const target = getBlueprint(db, a);
    const source = getBlueprint(db, b);
    expect(target.wins).toBe(3); // 2 + 1
    expect(target.losses).toBe(1); // 0 + 1
    expect(target.staffing.some((s) => s.personaId === 'p_researcher')).toBe(true); // 班底并入
    expect(target.tools.some((t) => t.id === 'web_fetch')).toBe(true);
    expect(source.status).toBe('retired');
    expect(listBlueprintVersions(db, target.id)[0]!.summary).toContain('合并');
  });
});
