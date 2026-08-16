/**
 * 蓝图深度优化（批次4）：
 * - 规则引擎建议：高胜率→锁定、低评分→淘汰、近重复→合并、缺描述→润色
 * - 幂等：同蓝图同动作 pending 不重复生成
 * - 采纳落地走版本化：锁定/淘汰/合并/描述各自出版；合并后源蓝图退役
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createNovelCompany } from './setup';
import { createProject } from '../../src/server/domain/project';
import { evolveBlueprint, listBlueprintVersions, getBlueprint, setBlueprintStatus } from '../../src/server/domain/blueprint';
import {
  generateBlueprintOptimization, listOptimizationItems, applyOptimizationItem, ignoreOptimizationItem,
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

describe('blueprint optimizer', () => {
  it('规则引擎：高胜率样本足→锁定；低评分→淘汰；缺描述→润色', async () => {
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

    const { source, items } = await generateBlueprintOptimization(db, companyId);
    expect(source).toBe('rules');
    const pending = items.filter((i) => i.status === 'pending');
    expect(pending.some((i) => i.blueprintId === good && i.actionType === 'lock')).toBe(true);
    expect(pending.some((i) => i.blueprintId === bad && i.actionType === 'retire')).toBe(true);
    // 描述创建时已自动生成（>=20 字），不触发润色建议
    expect(pending.some((i) => i.actionType === 'polish_description')).toBe(false);

    // 幂等：再生成不重复
    const again = await generateBlueprintOptimization(db, companyId);
    expect(again.items.filter((i) => i.status === 'pending').length).toBe(pending.length);
  });

  it('采纳锁定/淘汰/描述：落地并出版版本；忽略后不再可采纳', async () => {
    const good = seedBlueprint('制作产品发布会 PPT', 'p_writer', '笔杆子', true);
    for (let i = 1; i < 5; i++) {
      evolveBlueprint(db, { companyId, projectId, taskTitle: `制作产品发布会 PPT 第${i}稿`, personaId: 'p_writer', personaName: '笔杆子', win: true });
    }
    await generateBlueprintOptimization(db, companyId);
    const lockItem = listOptimizationItems(db, companyId).find((i) => i.actionType === 'lock' && i.blueprintId === good)!;
    // 清空描述后生成润色建议（规则引擎兜底，无 LLM 文本 → 采纳时应拒绝落地）
    db.prepare("UPDATE blueprint SET description='' WHERE id=?").run(good);
    await generateBlueprintOptimization(db, companyId);
    const polishItem = listOptimizationItems(db, companyId).find((i) => i.actionType === 'polish_description' && i.blueprintId === good)!;

    const before = listBlueprintVersions(db, good).length;
    const lockResult = applyOptimizationItem(db, lockItem.id);
    expect(lockResult.applied).toBe(true);
    expect(getBlueprint(db, good).status).toBe('locked');
    expect(listBlueprintVersions(db, good).length).toBe(before + 1);
    expect(listBlueprintVersions(db, good)[0]!.summary).toContain('锁定');

    // 描述建议没有 LLM 文本时不可落地
    const polishResult = applyOptimizationItem(db, polishItem.id);
    expect(polishResult.applied).toBe(false);

    // 忽略
    ignoreOptimizationItem(db, polishItem.id);
    expect(listOptimizationItems(db, companyId).find((i) => i.id === polishItem.id)!.status).toBe('ignored');
    expect(applyOptimizationItem(db, polishItem.id).applied).toBe(false);
  });

  it('采纳合并：班底/战绩相加、源蓝图退役、目标出版', async () => {
    // 两张"经常抢同一批任务但未合并"的蓝图（词元相似度 0.33，处于 0.25-0.4 区间）
    const a = seedBlueprint('行业调研报告撰写', 'p_writer', '笔杆子', true);
    evolveBlueprint(db, { companyId, projectId, taskTitle: '行业调研报告撰写 初稿', personaId: 'p_writer', personaName: '笔杆子', win: true, reworkCount: 1 });
    const b = seedBlueprint('行业调研排版整理', 'p_researcher', '研究员', true);
    evolveBlueprint(db, { companyId, projectId, taskTitle: '行业调研排版整理 汇编', personaId: 'p_researcher', personaName: '研究员', win: false, tools: ['web_fetch'] });

    await generateBlueprintOptimization(db, companyId);
    // 合并方向由战绩并列时的排序决定，断言与方向无关
    const mergeItem = listOptimizationItems(db, companyId).find((i) =>
      i.actionType === 'merge' && [a, b].includes(i.blueprintId) && i.targetBlueprintId !== null && [a, b].includes(i.targetBlueprintId!));
    expect(mergeItem).toBeTruthy();

    const result = applyOptimizationItem(db, mergeItem!.id);
    expect(result.applied).toBe(true);
    const target = getBlueprint(db, mergeItem!.targetBlueprintId!);
    const source = getBlueprint(db, mergeItem!.blueprintId);
    expect(target.wins).toBe(3); // 2 + 1
    expect(target.losses).toBe(1); // 0 + 1
    expect(target.staffing.some((s) => s.personaId === 'p_researcher')).toBe(true); // 班底并入
    expect(target.tools.some((t) => t.id === 'web_fetch')).toBe(true);
    expect(source.status).toBe('retired');
    expect(listBlueprintVersions(db, target.id)[0]!.summary).toContain('合并');
  });
});
