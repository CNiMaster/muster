import { restoreWorkbench } from '../../src/server/domain/workbench';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, setDbForTest, closeDb, DB } from '../../src/server/db/client';
import { makeTestDb, TestDb } from '../integration/setup';
import {
  evolveBlueprint,
  getBlueprint,
  getBlueprintDetail,
  publishBlueprintDebugResult,
  listBlueprintVersions,
} from '../../src/server/domain/blueprint';
;
import { createProject } from '../../src/server/domain/project';
import { clonePersonaAsUser, updateUserCustomConfig } from '../../src/server/domain/agent-profile';

describe('Blueprint Detail, Debug Adopt & Positive Evolution', () => {
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

  it('calculates multi-dimensional scorecard and maps active user talent on staffing slots', () => {
    const db = getDb();
    const company = restoreWorkbench(db, { id: 'wb_fix_1', name: `BP Co ${Date.now()}` });
    const project = createProject(db, { companyId: company.id, name: 'Web Project' });

    // Seed blueprint with 3 wins and 1 loss
    const bp = evolveBlueprint(db, {
      companyId: company.id,
      projectId: project.id,
      taskTitle: 'Build React navigation menu',
      personaId: 'frontend/engineering-frontend-developer',
      personaName: 'React Developer',
      win: true,
      reworkCount: 0,
      correctionCount: 0,
      tools: ['write_to_file', 'view_file'],
    });

    evolveBlueprint(db, {
      companyId: company.id,
      projectId: project.id,
      taskTitle: 'Build React navigation menu dropdown',
      personaId: 'frontend/engineering-frontend-developer',
      personaName: 'React Developer',
      win: true,
      reworkCount: 0,
      correctionCount: 1,
    });

    evolveBlueprint(db, {
      companyId: company.id,
      projectId: project.id,
      taskTitle: 'Build React navigation menu drawer',
      personaId: 'frontend/engineering-frontend-developer',
      personaName: 'React Developer',
      win: true,
      reworkCount: 1,
      correctionCount: 0,
    });

    // Create active user talent for frontend/engineering-frontend-developer
    const userTalent = clonePersonaAsUser(db, 'frontend/engineering-frontend-developer', 'My Elite Frontender');
    updateUserCustomConfig(db, userTalent.id, { isAutoDispatch: 1 });

    const detail = getBlueprintDetail(db, bp.id);
    expect(detail.id).toBe(bp.id);
    expect(detail.wins).toBe(3);
    expect(detail.score.winRate).toBe(100);
    expect(detail.score.score).not.toBeNull();
    expect(detail.staffingWithActiveTalents.length).toBeGreaterThan(0);
    expect(detail.staffingWithActiveTalents[0].activeUserTalent?.id).toBe(userTalent.id);
    expect(detail.tools.length).toBe(2);
  });

  it('atomically publishes blueprint debug results and commits version', () => {
    const db = getDb();
    const company = restoreWorkbench(db, { id: 'wb_fix_1', name: `Debug Co ${Date.now()}` });
    const project = createProject(db, { companyId: company.id, name: 'Web Project' });

    const bp = evolveBlueprint(db, {
      companyId: company.id,
      projectId: project.id,
      taskTitle: 'Fullstack dashboard development',
      personaId: 'frontend/engineering-frontend-developer',
      personaName: 'Frontend Dev',
      win: true,
    });

    const updated = publishBlueprintDebugResult(db, {
      blueprintId: bp.id,
      description: '重构后的现代化全栈工作流打法',
      staffing: [
        { personaId: 'frontend/engineering-frontend-developer', personaName: 'Frontend Lead' },
        { personaId: 'backend/engineering-backend-architect', personaName: 'Backend Architect' },
      ],
      tools: [
        { kind: 'tool', id: 'run_command', uses: 5, wins: 5 },
      ],
      summary: '重构引入后端架构师与自动化命令工具',
      evidenceTaskId: 'task_debug_123',
    });

    expect(updated.description).toBe('重构后的现代化全栈工作流打法');
    expect(updated.staffing.length).toBe(2);
    expect(updated.tools.length).toBe(1);

    const versions = listBlueprintVersions(db, bp.id);
    expect(versions[0].summary).toContain('重构引入后端架构师');
    expect(versions[0].evidence).toContain('task_debug_123');
  });

  it('positive evolution distills user talent win, negative shield protects baseline', () => {
    const db = getDb();
    const company = restoreWorkbench(db, { id: 'wb_fix_1', name: `Shield Co ${Date.now()}` });
    const project = createProject(db, { companyId: company.id, name: 'Web Project' });

    const officialBp = evolveBlueprint(db, {
      companyId: company.id,
      projectId: project.id,
      taskTitle: 'Write unit tests for authentication',
      personaId: 'qa/qa-engineer',
      personaName: 'QA Engineer',
      win: true,
      tools: ['vitest_runner'],
    });

    // 1. Negative shield: User talent fails -> official blueprint must NOT be degraded
    const protectedBp = evolveBlueprint(db, {
      companyId: company.id,
      projectId: project.id,
      taskTitle: 'Write unit tests for authentication jwt',
      personaId: 'qa/qa-engineer',
      personaName: 'QA Engineer',
      win: false,
      reworkCount: 2,
      isUserOverride: true,
      userTalentName: 'Custom QA Intern',
      tools: ['bad_broken_tool'],
    });

    expect(protectedBp.losses).toBe(0); // Official baseline didn't increase loss count
    expect(protectedBp.tools.some((t) => t.id === 'bad_broken_tool')).toBe(false);

    // 2. Positive distillation: User talent succeeds cleanly -> distill and record version
    const upgradedBp = evolveBlueprint(db, {
      companyId: company.id,
      projectId: project.id,
      taskTitle: 'Write unit tests for authentication oauth',
      personaId: 'qa/qa-engineer',
      personaName: 'QA Engineer',
      win: true,
      reworkCount: 0,
      isUserOverride: true,
      userTalentName: 'Elite QA Expert',
      tools: ['vitest_runner', 'coverage_checker'],
    });

    expect(upgradedBp.wins).toBe(2);
    expect(upgradedBp.tools.some((t) => t.id === 'coverage_checker')).toBe(true);

    const versions = listBlueprintVersions(db, officialBp.id);
    expect(versions[0].summary).toContain('正向吸收');
    expect(versions[0].summary).toContain('Elite QA Expert');
  });
});
