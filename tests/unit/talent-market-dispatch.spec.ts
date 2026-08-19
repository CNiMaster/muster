import { restoreWorkbench } from '../../src/server/domain/workbench';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, setDbForTest, closeDb, DB } from '../../src/server/db/client';
import { makeTestDb, TestDb } from '../integration/setup';
import {
  createAgentProfile,
  getAgentProfile,
  clonePersonaAsUser,
  cloneProfileAsUser,
  updateUserCustomConfig,
  findUserTalentForPersona,
} from '../../src/server/domain/agent-profile';
import { createTask, getTask } from '../../src/server/domain/task';
;
import { createProject } from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';
import { createProjectSpecialist } from '../../src/server/domain/specialist-pool';
import { evolveBlueprint } from '../../src/server/domain/blueprint';

describe('Talent Market & Auto-Dispatch Routing (Phase 1)', () => {
  let testDb: TestDb;
  let db: DB;

  beforeEach(() => {
    testDb = makeTestDb();
    db = testDb.db;
    setDbForTest(db);
  });

  afterEach(() => {
    testDb.close();
    closeDb();
  });

  it('clones a persona into a user talent with active duty by default', () => {
    const db = getDb();
    const customTalent = clonePersonaAsUser(db, 'frontend/engineering-frontend-developer', 'My React Specialist');
    expect(customTalent.id).toBeTruthy();
    expect(customTalent.displayName).toBe('My React Specialist');
    expect(customTalent.source).toBe('user');
    expect(customTalent.sourcePersonaId).toBe('frontend/engineering-frontend-developer');
    expect(customTalent.isAutoDispatch).toBe(1);
    expect(customTalent.soul).toBeTruthy();
  });

  it('updates custom config and allows toggling auto-dispatch on/off', () => {
    const db = getDb();
    const talent = clonePersonaAsUser(db, 'frontend/engineering-frontend-developer');
    expect(talent.isAutoDispatch).toBe(1);

    // Toggle off (休息中)
    const rested = updateUserCustomConfig(db, talent.id, {
      isAutoDispatch: 0,
      customModel: 'deepseek-r1',
      customThinkingDepth: 'high',
      principles: ['Always write unit tests first'],
    });
    expect(rested.isAutoDispatch).toBe(0);
    expect(rested.customModel).toBe('deepseek-r1');
    expect(rested.customThinkingDepth).toBe('high');
    expect(rested.principles).toEqual(['Always write unit tests first']);

    // findUserTalentForPersona should return null when resting
    const foundWhileRested = findUserTalentForPersona(db, 'frontend/engineering-frontend-developer');
    expect(foundWhileRested).toBeNull();

    // Toggle back on (自动上岗)
    const onDuty = updateUserCustomConfig(db, talent.id, { isAutoDispatch: 1 });
    expect(onDuty.isAutoDispatch).toBe(1);

    const foundOnDuty = findUserTalentForPersona(db, 'frontend/engineering-frontend-developer');
    expect(foundOnDuty).not.toBeNull();
    expect(foundOnDuty?.id).toBe(talent.id);
  });

  it('forbids mutating non-user profiles via updateUserCustomConfig', () => {
    const db = getDb();
    const sysProfile = createAgentProfile(db, {
      displayName: 'System Crystal Agent',
      source: 'crystallized',
    });

    expect(() => {
      updateUserCustomConfig(db, sysProfile.id, { displayName: 'Hacked Name' });
    }).toThrow(/系统预置与沉淀专家由系统自动管理/);
  });

  it('routes task to user custom talent when auto-dispatch is enabled, falls back to official baseline when resting', () => {
    const db = getDb();
    const company = restoreWorkbench(db, { id: 'wb_fix_1', name: `Dispatch Co ${Date.now()}` });
    const project = createProject(db, { companyId: company.id, name: 'Web Project' });
    const agent = createAgent(db, { companyId: company.id, name: 'Lead Dev', role: 'lead' });

    // Seed a blueprint for react development
    evolveBlueprint(db, {
      companyId: company.id,
      taskTitle: 'Develop React navigation bar',
      personaId: 'frontend/engineering-frontend-developer',
      personaName: 'React Developer',
      win: true,
      tools: [],
      projectId: project.id,
    });

    // Case A: With User Talent on Active Duty
    const userTalent = clonePersonaAsUser(db, 'frontend/engineering-frontend-developer', 'Elite React Dev');
    updateUserCustomConfig(db, userTalent.id, {
      customModel: 'claude-3-7-sonnet',
      customThinkingDepth: 'high',
      isAutoDispatch: 1,
    });

    const taskWithUser = createTask(db, {
      projectId: project.id,
      title: 'Develop React navigation bar component',
      assigneeAgentId: agent.id,
    });

    expect(taskWithUser.inputProtocol.blueprintMatched).toBeTruthy();
    expect(taskWithUser.inputProtocol.staffingMode).toBe('user_override');
    expect((taskWithUser.inputProtocol.userTalentOverride as any)?.profileId).toBe(userTalent.id);
    expect((taskWithUser.inputProtocol.userTalentOverride as any)?.customModel).toBe('claude-3-7-sonnet');

    // Case B: User Talent goes on Rest
    updateUserCustomConfig(db, userTalent.id, { isAutoDispatch: 0 });

    const taskWithOfficial = createTask(db, {
      projectId: project.id,
      title: 'Develop React navigation bar modal',
      assigneeAgentId: agent.id,
    });

    expect(taskWithOfficial.inputProtocol.blueprintMatched).toBeTruthy();
    expect(taskWithOfficial.inputProtocol.staffingMode).toBe('official_benchmark');
    expect(taskWithOfficial.inputProtocol.userTalentOverride).toBeUndefined();
  });

  it('routes unassigned blueprint-matched task to project specialist pool (组织模型批次二续)', () => {
    const db = getDb();
    const company = restoreWorkbench(db, { id: 'wb_fix_2', name: `Pool Co ${Date.now()}` });
    const project = createProject(db, { companyId: company.id, name: 'Pool Project' });
    const lead = createAgent(db, { companyId: company.id, name: 'Lead', role: 'lead' });
    evolveBlueprint(db, {
      companyId: company.id,
      taskTitle: 'Develop React navigation bar',
      personaId: 'frontend/engineering-frontend-developer',
      personaName: 'React Developer',
      win: true,
      tools: [],
      projectId: project.id,
    });

    // 项目专家池：该人设已落成常驻专家
    const specialist = createProjectSpecialist(db, {
      projectId: project.id,
      specialty: 'React 开发',
      personaId: 'frontend/engineering-frontend-developer',
      via: 'manual',
    });

    // 未指定执行者 + 蓝图命中 → 直接派给池内常驻专家（跨任务延续线程与记忆）
    const pooled = createTask(db, { projectId: project.id, title: 'Develop React navigation bar modal' });
    expect(pooled.inputProtocol.blueprintMatched).toBeTruthy();
    expect(pooled.inputProtocol.staffingMode).toBe('specialist-pool');
    expect(pooled.assigneeAgentId).toBe(specialist.agentId);

    // 已显式指定执行者 → 只穿衣不换人（维持原语义）
    void lead;
    const explicit = createTask(db, {
      projectId: project.id,
      title: 'Develop React navigation bar drawer',
      assigneeAgentId: lead.id,
    });
    expect(explicit.inputProtocol.staffingMode).not.toBe('specialist-pool');
    expect(explicit.assigneeAgentId).toBe(lead.id);
  });
});
