import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';
import { evolveBlueprint, matchTopPersonasForBlueprint, addBlueprintStaffingSlot, getBlueprint } from '../../src/server/domain/blueprint';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('蓝图人设 Top Matches 与右侧栏采纳（批次 F）', () => {
  it('matchTopPersonasForBlueprint 按照蓝图词元相关度为蓝图匹配推荐人设', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_btm_1', name: '工作台' });
    const lead = createAgent(db, { companyId: workbench.id, name: '领班', role: 'lead' });
    const project = createProject(db, { companyId: workbench.id, name: '财务项目', firstAgentId: lead.id });

    const bp = evolveBlueprint(db, {
      companyId: workbench.id,
      projectId: project.id,
      taskTitle: '负责财务预算建模与财务预测分析',
      personaId: 'data/finance-financial-analyst',
      personaName: '财务分析专家',
      win: true,
    });

    const matches = matchTopPersonasForBlueprint(db, bp.id, 5);
    expect(matches.length).toBeGreaterThan(0);
    // 应命中财务相关人设（如 financial-analyst 或 financial-forecaster）
    expect(matches[0].persona.id).toMatch(/finance|financial/);
    expect(matches[0].score).toBeGreaterThan(0);
  });

  it('addBlueprintStaffingSlot 采纳人设进班底并追加版本提交', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_btm_adopt', name: '工作台' });
    const lead = createAgent(db, { companyId: workbench.id, name: '领班', role: 'lead' });
    const project = createProject(db, { companyId: workbench.id, name: '营销项目', firstAgentId: lead.id });

    const bp = evolveBlueprint(db, {
      companyId: workbench.id,
      projectId: project.id,
      taskTitle: '产出小红书公众号新媒体营销文案',
      personaId: 'marketing/marketing-content-creator',
      personaName: '文案创作者',
      win: true,
    });

    const updated = addBlueprintStaffingSlot(db, bp.id, {
      personaId: 'social/social-redbook-operator',
      personaName: '小红书操盘手',
    });

    expect(updated.staffing.some((s) => s.personaId === 'social/social-redbook-operator')).toBe(true);

    // 重复采纳同一人设应幂等防重
    const countBefore = updated.staffing.length;
    const idempotent = addBlueprintStaffingSlot(db, bp.id, {
      personaId: 'social/social-redbook-operator',
      personaName: '小红书操盘手',
    });
    expect(idempotent.staffing).toHaveLength(countBefore);
  });
});
