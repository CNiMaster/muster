/**
 * 蓝图阶段工作流契约与写回（2026-08-29 蓝图工作流化批次①②③）：
 * - 共享契约：schema 通过/拒绝、DAG 环检测、语义校验（id 唯一/引用存在）、摘要、容错读取
 * - updateBlueprintStages：合法写回+版本提交；空/成环/幽灵引用拒绝；no-op 不出版；step 重排
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb, createNovelCompany } from '../integration/setup';
import { createProject } from '../../src/server/domain/project';
import { evolveBlueprint, getBlueprint, listBlueprintVersions, updateBlueprintStages } from '../../src/server/domain/blueprint';
import {
  blueprintStagesSchema,
  stagesHaveCycle,
  stageSemanticErrors,
  describeStages,
  coerceBlueprintStages,
  type BlueprintStage,
} from '../../src/shared/blueprint-stages';

let db: DB;
let blueprintId: string;

const LINEAR: BlueprintStage[] = [
  { id: 'stage_1', step: 1, label: '大纲', description: '定结构' },
  { id: 'stage_2', step: 2, label: '正文' },
  { id: 'stage_3', step: 3, label: '审校' },
];

beforeEach(() => {
  const tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  const project = createProject(db, { companyId: r.company.id, name: 'p', rootDir: '/tmp/bps', firstAgentId: r.agents.lead.id, initialState: 'active' });
  const bp = evolveBlueprint(db, { companyId: r.company.id, projectId: project.id, taskTitle: '写一篇约稿文章_xyz', personaId: 'p_writer', personaName: '笔杆子', win: true })!;
  blueprintId = bp.id;
});

describe('共享契约 blueprint-stages', () => {
  it('schema：合法阶段通过；缺 label / 超上限拒', () => {
    expect(blueprintStagesSchema.safeParse(LINEAR).success).toBe(true);
    expect(blueprintStagesSchema.safeParse([{ id: 's1', step: 1 }]).success).toBe(false);
    expect(blueprintStagesSchema.safeParse([{ id: 's1', step: '一', label: 'x' }]).success).toBe(false);
    const tooMany = Array.from({ length: 9 }, (_, i) => ({ id: `s${i + 1}`, step: i + 1, label: `阶段${i + 1}` }));
    expect(blueprintStagesSchema.safeParse(tooMany).success).toBe(false);
  });

  it('DAG：链式无环；a→b→a 成环检出', () => {
    expect(stagesHaveCycle(LINEAR)).toBe(false);
    const cyclic: BlueprintStage[] = [
      { id: 'a', step: 1, label: 'A', dependsOn: ['b'] },
      { id: 'b', step: 2, label: 'B', dependsOn: ['a'] },
    ];
    expect(stagesHaveCycle(cyclic)).toBe(true);
  });

  it('语义校验：id 重复 / 依赖不存在 / 自依赖各自报错', () => {
    expect(stageSemanticErrors(LINEAR)).toEqual([]);
    expect(stageSemanticErrors([
      { id: 'a', step: 1, label: 'A' },
      { id: 'a', step: 2, label: 'B' },
    ])).toContain('阶段 id 重复');
    expect(stageSemanticErrors([{ id: 'a', step: 1, label: 'A', dependsOn: ['ghost'] }])[0]).toContain('不存在的阶段');
    expect(stageSemanticErrors([{ id: 'a', step: 1, label: 'A', dependsOn: ['a'] }]).join()).toContain('依赖自己');
  });

  it('describeStages：按 step 排序输出链路；空=未定义', () => {
    expect(describeStages(LINEAR)).toBe('3 个阶段（大纲 → 正文 → 审校）');
    expect(describeStages([])).toBe('未定义');
  });

  it('coerceBlueprintStages：合法原样返回；坏数据/空安全降级空数组', () => {
    expect(coerceBlueprintStages(LINEAR)).toEqual(LINEAR);
    expect(coerceBlueprintStages(null)).toEqual([]);
    expect(coerceBlueprintStages([{ nope: 1 }])).toEqual([]);
  });
});

describe('updateBlueprintStages 写回', () => {
  it('合法写回：落库+出版，版本摘要含链路；step 乱序按数组语义重排', () => {
    const before = listBlueprintVersions(db, blueprintId).length;
    const updated = updateBlueprintStages(db, blueprintId, [
      { id: 'stage_2', step: 5, label: '正文' },
      { id: 'stage_1', step: 1, label: '大纲' },
    ]);
    expect(updated.stages).toEqual([
      { id: 'stage_1', step: 1, label: '大纲' },
      { id: 'stage_2', step: 2, label: '正文' },
    ]);
    const versions = listBlueprintVersions(db, blueprintId);
    expect(versions.length).toBe(before + 1);
    expect(versions[0]!.summary).toContain('阶段工作流更新');
    expect(versions[0]!.summary).toContain('大纲 → 正文');
    expect(versions[0]!.snapshot).toHaveProperty('stages');
  });

  it('no-op 不出版；带自定义 summary/evidence 透传', () => {
    updateBlueprintStages(db, blueprintId, LINEAR);
    const before = listBlueprintVersions(db, blueprintId).length;
    const again = updateBlueprintStages(db, blueprintId, [
      { id: 'stage_1', step: 1, label: '大纲', description: '定结构' },
      { id: 'stage_2', step: 2, label: '正文' },
      { id: 'stage_3', step: 3, label: '审校' },
    ]);
    expect(listBlueprintVersions(db, blueprintId).length).toBe(before);

    const custom = updateBlueprintStages(db, blueprintId, [
      { id: 'stage_1', step: 1, label: '新大纲' },
    ], { summary: '画布编辑：压缩为单阶段', evidence: ['canvas'] });
    expect(listBlueprintVersions(db, blueprintId)[0]!.summary).toBe('画布编辑：压缩为单阶段');
    expect(getBlueprint(db, custom.id).stages).toHaveLength(1);
  });

  it('防改坏：空数组/成环/幽灵依赖/班底外成员全部拒绝', () => {
    expect(() => updateBlueprintStages(db, blueprintId, [])).toThrow(/不能为空/);
    expect(() => updateBlueprintStages(db, blueprintId, [
      { id: 'a', step: 1, label: 'A', dependsOn: ['b'] },
      { id: 'b', step: 2, label: 'B', dependsOn: ['a'] },
    ])).toThrow(/成环/);
    expect(() => updateBlueprintStages(db, blueprintId, [
      { id: 'a', step: 1, label: 'A', dependsOn: ['ghost'] },
    ])).toThrow(/不存在的阶段/);
    expect(() => updateBlueprintStages(db, blueprintId, [
      { id: 'a', step: 1, label: 'A', staffingPersonaIds: ['p_ghost'] },
    ])).toThrow(/班底外的成员/);
    // 拒绝路径零副作用：蓝图 stages 保持原状
    expect(getBlueprint(db, blueprintId).stages).toEqual([]);
  });

  it('M2 批次B：gate/tools/staffingPersonaIds 随写回落库保留', () => {
    const updated = updateBlueprintStages(db, blueprintId, [
      {
        id: 'stage_1', step: 1, label: '终审',
        staffingPersonaIds: ['p_writer'],
        gate: 'acceptance',
        tools: [{ kind: 'skill', id: 'doc-writer' }, { kind: 'mcp', id: 'mcp_github__create_issue' }],
      },
    ]);
    const stage = (updated.stages as BlueprintStage[])[0]!;
    expect(stage.gate).toBe('acceptance');
    expect(stage.tools).toEqual([
      { kind: 'skill', id: 'doc-writer' },
      { kind: 'mcp', id: 'mcp_github__create_issue' },
    ]);
    expect(stage.staffingPersonaIds).toEqual(['p_writer']);
  });

  it('staffingPersonaIds 引用当前班底成员可通过', () => {
    const updated = updateBlueprintStages(db, blueprintId, [
      { id: 'stage_1', step: 1, label: '写作', staffingPersonaIds: ['p_writer'] },
    ]);
    expect((updated.stages as BlueprintStage[])[0]!.staffingPersonaIds).toEqual(['p_writer']);
  });
});
