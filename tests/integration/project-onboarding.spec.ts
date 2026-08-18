import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * B4 readiness 后端测试：
 * - getProjectReadiness/setProjectReadiness 读写（含 settings 命名空间隔离）
 * - validatePhaseExit 各阶段校验规则
 * - 回流不校验
 * - transitionProjectPhase 集成 validatePhaseExit
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createProject, getProject, type ProjectState } from '../../src/server/domain/project';
import {
  getProjectReadiness,
  setProjectReadiness,
  validatePhaseExit,
} from '../../src/server/domain/project-onboarding';
import { transitionProjectPhase } from '../../src/server/domain/project-readiness';
import { AppError, ErrorCode } from '../../src/shared/errors';
import { emptyProjectReadiness, type ProjectReadiness } from '../../src/shared/project-readiness';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;
let projectId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  companyId = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' }).id;
  projectId = createProject(db, {
    companyId,
    name: 'p',
    rootDir: makeTempGitRepo(),
  }).id;
});

afterEach(() => tdb.close());

const FULL_READINESS: ProjectReadiness = {
  draft: { goal: 'g', audience: 'a', constraints: 'c' },
  research: { summary: 's', candidateSkills: ['sk'], candidateTools: [] },
  equipment: { enabledPlugins: ['plg_x'], missingCapabilities: [] },
  staffing: { employeeIds: ['ag_x'] },
  notes: '',
};

describe('readiness 读写', () => {
  it('新项目 readiness 为空默认值', () => {
    const r = getProjectReadiness(db, projectId);
    expect(r).toEqual(emptyProjectReadiness());
  });

  it('setProjectReadiness 写入并合并其他 settings key', () => {
    // 先写一个孤立 settings key
    const project = getProject(db, projectId);
    // 直接 updateProject 设 settings 含其他 key
    db.prepare('UPDATE project SET settings_json = ? WHERE id = ?').run(
      JSON.stringify({ milestoneReviewAt: '2026-08-01', onboarding: emptyProjectReadiness() }),
      projectId,
    );
    setProjectReadiness(db, projectId, FULL_READINESS);
    const r = getProjectReadiness(db, projectId);
    expect(r.draft.goal).toBe('g');
    // 其他 key 保留
    const settings = JSON.parse(
      (db.prepare('SELECT settings_json FROM project WHERE id = ?').get(projectId) as { settings_json: string }).settings_json,
    ) as Record<string, unknown>;
    expect(settings.milestoneReviewAt).toBe('2026-08-01');
  });
});

describe('validatePhaseExit 向前跃迁校验', () => {
  it('drafting→researching 缺 goal 抛错', () => {
    expect(() => validatePhaseExit(db, projectId, 'drafting', 'researching')).toThrow(AppError);
  });

  it('drafting→researching 有 goal 通过', () => {
    setProjectReadiness(db, projectId, { ...emptyProjectReadiness(), draft: { goal: 'g', audience: '', constraints: '' } });
    expect(() => validatePhaseExit(db, projectId, 'drafting', 'researching')).not.toThrow();
  });

  it('researching→equipping 缺摘要抛错', () => {
    setProjectReadiness(db, projectId, { ...emptyProjectReadiness(), draft: { goal: 'g', audience: '', constraints: '' } });
    expect(() => validatePhaseExit(db, projectId, 'researching', 'equipping')).toThrow(AppError);
  });

  it('researching→equipping 缺候选能力抛错', () => {
    setProjectReadiness(db, projectId, {
      ...emptyProjectReadiness(),
      draft: { goal: 'g', audience: '', constraints: '' },
      research: { summary: 's', candidateSkills: [], candidateTools: [] },
    });
    expect(() => validatePhaseExit(db, projectId, 'researching', 'equipping')).toThrow(AppError);
  });

  it('equipping→staffing 缺 plugin 抛错', () => {
    setProjectReadiness(db, projectId, FULL_READINESS);
    expect(() => validatePhaseExit(db, projectId, 'equipping', 'staffing')).not.toThrow();
    // 清空 plugin
    setProjectReadiness(db, projectId, { ...FULL_READINESS, equipment: { enabledPlugins: [], missingCapabilities: [] } });
    expect(() => validatePhaseExit(db, projectId, 'equipping', 'staffing')).toThrow(AppError);
  });

  it('staffing→ready 缺员工抛错', () => {
    setProjectReadiness(db, projectId, { ...FULL_READINESS, staffing: { employeeIds: [] } });
    expect(() => validatePhaseExit(db, projectId, 'staffing', 'ready')).toThrow(AppError);
  });

  it('ready→active 全量复检通过', () => {
    setProjectReadiness(db, projectId, FULL_READINESS);
    expect(() => validatePhaseExit(db, projectId, 'ready', 'active')).not.toThrow();
  });

  it('ready→active 缺任意项抛错', () => {
    setProjectReadiness(db, projectId, { ...FULL_READINESS, draft: { goal: '', audience: '', constraints: '' } });
    expect(() => validatePhaseExit(db, projectId, 'ready', 'active')).toThrow(AppError);
  });
});

describe('validatePhaseExit 回流不校验', () => {
  it('staffing→drafting 即使全空也通过', () => {
    // 不填任何 readiness
    expect(() => validatePhaseExit(db, projectId, 'staffing', 'drafting')).not.toThrow();
  });

  it('active→researching 不校验', () => {
    expect(() => validatePhaseExit(db, projectId, 'active', 'researching')).not.toThrow();
  });
});

describe('transitionProjectPhase 集成 validatePhaseExit', () => {
  it('向前跃迁缺产物被拦', () => {
    expect(() => transitionProjectPhase(db, projectId, 'researching')).toThrow(AppError);
    expect(getProject(db, projectId).state).toBe('drafting');
  });

  it('填齐后走完整流程到 active', () => {
    setProjectReadiness(db, projectId, FULL_READINESS);
    for (const target of ['researching', 'equipping', 'staffing', 'ready', 'active'] as ProjectState[]) {
      transitionProjectPhase(db, projectId, target);
    }
    expect(getProject(db, projectId).state).toBe('active');
  });

  it('错误码为 VALIDATION', () => {
    try {
      validatePhaseExit(db, projectId, 'drafting', 'researching');
      expect.fail('应抛错');
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.VALIDATION);
    }
  });
});
