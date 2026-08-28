/**
 * 预制蓝图（2026-08-28 定案）：8 套开箱即用打法。
 * - 播种：source='preset' + 原版快照；staffing personaId 全部真实存在（防拼写断链）
 * - 幂等：二次调用零新增；用户 retire 后 ensure 不复活（查重含全部状态）
 * - 匹配：小说标题命中穿戴主笔（短标题 jaccard / 长标题子串兜底）
 * - 进化共存：evolve 记战绩不动快照；reset 恢复原版+清战绩+版本留痕；evolved 蓝图拒绝 reset
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import {
  BLUEPRINT_PRESETS, ensureBlueprintPresets,
} from '../../src/server/domain/blueprint-presets';
import {
  listBlueprints, matchBlueprint, evolveBlueprint, getBlueprint,
  resetBlueprint, setBlueprintStatus, listBlueprintVersions,
} from '../../src/server/domain/blueprint';
import { listPersonas } from '../../src/server/domain/persona-library';
import { createProject } from '../../src/server/domain/project';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

function seed(): { workbenchId: string; projectId: string } {
  const workbench = restoreWorkbench(db, { id: 'wb_preset', name: '工作台' });
  const project = createProject(db, { companyId: workbench.id, name: '预制蓝图项目', initialState: 'active' });
  return { workbenchId: workbench.id, projectId: project.id };
}

const NOVEL_TASK_TYPE = '小说|正文|章节';

describe('预制蓝图播种', () => {
  it('8 套定义完整：staffing personaId 全部真实存在、主槽在前、不超槽位上限', () => {
    const ids = new Set(listPersonas().map((p) => p.id));
    expect(BLUEPRINT_PRESETS.length).toBe(8);
    for (const preset of BLUEPRINT_PRESETS) {
      expect(preset.taskType.split('|').filter(Boolean).length).toBeGreaterThanOrEqual(2);
      expect(preset.staffing.length).toBeGreaterThanOrEqual(2);
      expect(preset.staffing.length).toBeLessThanOrEqual(4);
      for (const slot of preset.staffing) {
        expect(ids.has(slot.personaId), `${preset.label} 的 ${slot.personaId} 应存在于人设库`).toBe(true);
      }
    }
  });

  it('播种 8 条 source=preset 带原版快照；二次调用幂等零新增', () => {
    seed();
    ensureBlueprintPresets(db);
    const afterFirst = listBlueprints(db);
    expect(afterFirst.filter((bp) => bp.source === 'preset')).toHaveLength(8);
    for (const bp of afterFirst) {
      if (bp.source !== 'preset') continue;
      expect(bp.presetSnapshot).not.toBeNull();
      expect(bp.status).toBe('active');
      expect(bp.wins + bp.losses).toBe(0);
      expect(bp.presetSnapshot!.staffing).toEqual(bp.staffing);
    }
    ensureBlueprintPresets(db);
    expect(listBlueprints(db)).toHaveLength(afterFirst.length);
  });

  it('用户 retire 后 ensure 不复活（查重含全部状态）', () => {
    const { workbenchId } = seed();
    ensureBlueprintPresets(db);
    const novel = listBlueprints(db).find((bp) => bp.taskType === NOVEL_TASK_TYPE)!;
    setBlueprintStatus(db, novel.id, 'retired');
    ensureBlueprintPresets(db);
    expect(getBlueprint(db, novel.id).status).toBe('retired');
    expect(listBlueprints(db).filter((bp) => bp.taskType === NOVEL_TASK_TYPE)).toHaveLength(1);
    void workbenchId;
  });
});

describe('预制蓝图匹配', () => {
  it('短标题 jaccard 命中：写小说 → 主笔穿戴', () => {
    const { workbenchId } = seed();
    ensureBlueprintPresets(db);
    const match = matchBlueprint(db, workbenchId, '写小说');
    expect(match?.blueprint.taskType).toBe(NOVEL_TASK_TYPE);
    expect(match?.blueprint.staffing[0]?.personaId).toBe('novel/novel-writer');
  });

  it('长标题子串兜底：写一章小说（jaccard 稀释至 0.167 仍命中）', () => {
    const { workbenchId } = seed();
    ensureBlueprintPresets(db);
    const match = matchBlueprint(db, workbenchId, '给主角写一章小说，重点是重逢场面');
    expect(match?.blueprint.taskType).toBe(NOVEL_TASK_TYPE);
    expect(match?.blueprint.staffing[0]?.personaName).toBe('小说主笔');
  });

  it('其他域各自命中：修复登录 bug → 软件交付；剪辑一条视频 → 视频制作', () => {
    const { workbenchId } = seed();
    ensureBlueprintPresets(db);
    const sw = matchBlueprint(db, workbenchId, '修复登录页面的 bug');
    expect(sw?.blueprint.label).toBe('软件交付');
    const vd = matchBlueprint(db, workbenchId, '剪辑一条产品介绍视频');
    expect(vd?.blueprint.label).toBe('视频制作');
  });
});

describe('预制蓝图进化与重置', () => {
  it('evolve 记战绩扩班底，原版快照不动；reset 恢复原版+清战绩+版本留痕', () => {
    const { workbenchId, projectId } = seed();
    ensureBlueprintPresets(db);
    const novel = listBlueprints(db).find((bp) => bp.taskType === NOVEL_TASK_TYPE)!;
    const snapshotBefore = novel.presetSnapshot!;

    // 进化：记一胜 + 工具入账（小说班底已满 4 槽不扩员——上限行为，散人测试走 3 槽域）
    const outsider = listPersonas().find((p) => !novel.staffing.some((s) => s.personaId === p.id))!;
    const evolved = evolveBlueprint(db, {
      companyId: workbenchId, projectId, taskTitle: '写小说正文章节',
      personaId: outsider.id, personaName: outsider.name, win: true, tools: ['edit_file'],
    })!;
    expect(evolved.id).toBe(novel.id);
    expect(evolved.wins).toBe(1);
    expect(evolved.tools.length).toBe(1);
    expect(evolved.staffing).toHaveLength(4);
    expect(getBlueprint(db, novel.id).presetSnapshot).toEqual(snapshotBefore);

    // 3 槽域验扩员：视频制作 evolve 新人设入组
    const video = listBlueprints(db).find((bp) => bp.label === '视频制作')!;
    const evolvedVideo = evolveBlueprint(db, {
      companyId: workbenchId, projectId, taskTitle: '剪辑产品视频短片',
      personaId: outsider.id, personaName: outsider.name, win: true,
    })!;
    expect(evolvedVideo.id).toBe(video.id);
    expect(evolvedVideo.staffing.some((s) => s.personaId === outsider.id)).toBe(true);

    // 重置：恢复原版班底与描述、清工具与战绩、版本链留痕
    const reset = resetBlueprint(db, novel.id);
    expect(reset.staffing).toEqual(snapshotBefore.staffing);
    expect(reset.description).toBe(snapshotBefore.description);
    expect(reset.tools).toHaveLength(0);
    expect(reset.wins + reset.losses).toBe(0);
    expect(listBlueprintVersions(db, novel.id).some((v) => v.summary.includes('重置为原版'))).toBe(true);
  });

  it('evolved 蓝图拒绝重置（无原版概念，走版本回滚）', () => {
    const { workbenchId, projectId } = seed();
    ensureBlueprintPresets(db);
    const p = listPersonas()[0]!;
    const evolved = evolveBlueprint(db, {
      companyId: workbenchId, projectId, taskTitle: '一个全新的独特活儿_xyz',
      personaId: p.id, personaName: p.name, win: true,
    })!;
    expect(evolved.source).toBe('evolved');
    expect(() => resetBlueprint(db, evolved.id)).toThrow();
  });
});
