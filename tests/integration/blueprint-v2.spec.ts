/**
 * 蓝图打法包一期（进化环收拢批次2）：
 * - 多维记账：返工轮次/用户纠正/工具调用并入蓝图；描述模板生成
 * - 版本化：仅结构性变更出版（新建/班底/工具集/状态/回滚），纯计数不出版；上限 30 版
 * - 回滚恢复结构字段、战绩保留、另记一版
 * - matchBlueprints top-N 去同簇
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createNovelCompany } from './setup';
import { createProject } from '../../src/server/domain/project';
import {
  evolveBlueprint, setBlueprintStatus, listBlueprintVersions, rollbackBlueprint,
  matchBlueprints, updateBlueprintDescription,
} from '../../src/server/domain/blueprint';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;
let projectId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  companyId = r.company.id;
  const project = createProject(db, { companyId, name: 'p', rootDir: '/tmp/bp2', firstAgentId: r.agents.lead.id, initialState: 'active' });
  projectId = project.id;
});

describe('blueprint v2', () => {
  it('新建蓝图：描述模板 + 多维战绩 + 工具记账 + 一版提交', () => {
    const bp = evolveBlueprint(db, {
      companyId, projectId, taskTitle: '制作产品发布会 PPT', personaId: 'p_writer', personaName: '笔杆子',
      win: true, reworkCount: 1, correctionCount: 2, tools: ['web_fetch', 'slides'],
    });
    expect(bp.description).toContain('制作产品发布会 PPT');
    expect(bp.reworkTotal).toBe(1);
    expect(bp.correctionTotal).toBe(2);
    expect(bp.tools).toEqual([{ kind: 'tool', id: 'web_fetch', uses: 1, wins: 1 }, { kind: 'tool', id: 'slides', uses: 1, wins: 1 }]);
    const versions = listBlueprintVersions(db, bp.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.summary).toContain('创建蓝图');
    expect(versions[0]!.version).toBe(1);
  });

  it('纯计数不出版；班底/工具集变化出版', () => {
    const bp = evolveBlueprint(db, { companyId, projectId, taskTitle: '制作产品发布会 PPT', personaId: 'p_writer', personaName: '笔杆子', win: true });
    // 同人设再来一次(纯胜负+1):不出版
    evolveBlueprint(db, { companyId, projectId, taskTitle: '制作产品发布会 PPT 初稿', personaId: 'p_writer', personaName: '笔杆子', win: false });
    expect(listBlueprintVersions(db, bp.id)).toHaveLength(1);
    // 新协作成员进班底:出版
    const bp2 = evolveBlueprint(db, { companyId, projectId, taskTitle: '制作产品发布会 PPT 终稿', personaId: 'p_designer', personaName: '设计师', win: true });
    expect(listBlueprintVersions(db, bp2.id)).toHaveLength(2);
    expect(listBlueprintVersions(db, bp2.id)[0]!.summary).toContain('班底扩充');
    // 新工具:出版
    const bp3 = evolveBlueprint(db, { companyId, projectId, taskTitle: '制作产品发布会 PPT', personaId: 'p_writer', personaName: '笔杆子', win: true, tools: ['image_gen'] });
    expect(listBlueprintVersions(db, bp3.id)).toHaveLength(3);
    expect(listBlueprintVersions(db, bp3.id)[0]!.summary).toContain('工具集扩充');
  });

  it('版本上限 30：超出丢最旧', () => {
    const bp = evolveBlueprint(db, { companyId, projectId, taskTitle: '制作产品发布会 PPT', personaId: 'p_writer', personaName: '笔杆子', win: true });
    // 制造 40 次状态切换(每次都是一版结构提交)
    for (let i = 0; i < 40; i++) {
      setBlueprintStatus(db, bp.id, i % 2 === 0 ? 'locked' : 'active');
    }
    const versions = listBlueprintVersions(db, bp.id);
    expect(versions.length).toBeLessThanOrEqual(30);
    const nums = versions.map((v) => v.version);
    expect(Math.max(...nums)).toBeGreaterThan(30); // 后续版本仍在,最旧被丢
  });

  it('状态切换出版；回滚恢复结构、战绩保留、另记一版', () => {
    const bp = evolveBlueprint(db, { companyId, projectId, taskTitle: '制作产品发布会 PPT', personaId: 'p_writer', personaName: '笔杆子', win: true });
    const withCrew = evolveBlueprint(db, { companyId, projectId, taskTitle: '制作产品发布会 PPT 变体A', personaId: 'p_designer', personaName: '设计师', win: true });
    const v2 = listBlueprintVersions(db, bp.id).find((v) => v.version === 2)!;
    setBlueprintStatus(db, bp.id, 'locked');
    expect(listBlueprintVersions(db, bp.id)[0]!.summary).toContain('锁定');

    const rolled = rollbackBlueprint(db, bp.id, v2.version);
    expect(rolled.staffing).toEqual(withCrew.staffing);
    expect(rolled.status).toBe('active');
    expect(rolled.wins).toBe(withCrew.wins); // 战绩保留
    expect(listBlueprintVersions(db, bp.id)[0]!.summary).toContain('回滚到');
  });

  it('matchBlueprints 返回 top-N 且去同簇', () => {
    evolveBlueprint(db, { companyId, projectId, taskTitle: '行业调研报告撰写', personaId: 'p_writer', personaName: '笔杆子', win: true });
    evolveBlueprint(db, { companyId, projectId, taskTitle: '行业调研报告整理', personaId: 'p_researcher', personaName: '研究员', win: true });
    evolveBlueprint(db, { companyId, projectId, taskTitle: '产品宣传视频制作', personaId: 'p_editor', personaName: '剪辑师', win: true });
    const matches = matchBlueprints(db, companyId, '行业调研报告初稿撰写', 3);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.length).toBeLessThanOrEqual(2); // 两张调研类蓝图被视为同簇只取一张
    expect(matches[0]!.blueprint.taskType).toContain('调研');
  });

  it('描述更新出版', () => {
    const bp = evolveBlueprint(db, { companyId, projectId, taskTitle: '制作产品发布会 PPT', personaId: 'p_writer', personaName: '笔杆子', win: true });
    const updated = updateBlueprintDescription(db, bp.id, '制作与包装演示文稿的完整打法：先调研受众，再定结构，最后出片。');
    expect(updated.description).toContain('完整打法');
    expect(listBlueprintVersions(db, bp.id)[0]!.summary).toContain('描述更新');
  });
});
