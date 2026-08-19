import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createAgent, listAgents } from '../../src/server/domain/agent';
import { evolveBlueprint, generateBlueprintCrewStaffing, applyBlueprintCrewStaffing } from '../../src/server/domain/blueprint';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('蓝图专家团队编制推荐与入职集成（批次 J）', () => {
  it('generateBlueprintCrewStaffing 推荐完整编制方案，applyBlueprintCrewStaffing 批量入职到工作台', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_crew_1', name: '编制测试工作台' });
    const lead = createAgent(db, { companyId: workbench.id, name: '领班干员', role: 'lead' });
    const project = createProject(db, {
      companyId: workbench.id,
      name: '蓝图编制项目',
      rootDir: '/tmp/test-blueprint-crew',
      firstAgentId: lead.id,
    });

    // 1. 创建蓝图
    const bp = evolveBlueprint(db, {
      companyId: workbench.id,
      projectId: project.id,
      taskTitle: '负责全栈 Web 架构开发与系统部署',
      personaId: 'engineering/engineering-fullstack-dev',
      personaName: '全栈架构师',
      win: true,
    });

    // 2. 生成推荐编制
    const plan = generateBlueprintCrewStaffing(db, bp.id);
    expect(plan.blueprintId).toBe(bp.id);
    expect(plan.crew.length).toBeGreaterThanOrEqual(1);

    // 3. 一键入职到工作台
    const applyRes = applyBlueprintCrewStaffing(db, project.id, bp.id, plan.crew);
    expect(applyRes.appliedCount).toBeGreaterThanOrEqual(1);
    expect(applyRes.createdAgents.length).toBe(applyRes.appliedCount);

    // 4. 验证工作台中已存在对应 Agent 且具备相应角色与技能
    const agents = listAgents(db);
    const names = agents.map((a) => a.name);
    for (const member of applyRes.createdAgents) {
      expect(names).toContain(member.name);
    }

    // 5. 幂等性：再次入职不会重复创建同名 Agent
    const applyRes2 = applyBlueprintCrewStaffing(db, project.id, bp.id, plan.crew);
    expect(applyRes2.appliedCount).toBe(0);
  });
});
