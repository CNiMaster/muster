import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * B2 状态机集成测试：
 * - createProject 默认 drafting
 * - assertCanTransition 合法/非法转换（顺序推进、回流、active↔paused、终态）
 * - transitionProjectPhase 跃迁 + 回流
 * - assertProjectActive 派工闸门
 * - createProject initialState 参数可跳过准备流程
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createProject, getProject, type ProjectState } from '../../src/server/domain/project';
import {
  assertCanTransition,
  transitionProjectPhase,
  assertProjectActive,
} from '../../src/server/domain/project-readiness';
import { setProjectReadiness } from '../../src/server/domain/project-onboarding';
import { AppError, ErrorCode } from '../../src/shared/errors';

/** 填充完整 readiness，让向前跃迁过 validatePhaseExit（B4 后跃迁需产物）。 */
function fillReadiness(db2: DB, id: string): void {
  setProjectReadiness(db2, id, {
    draft: { goal: 'g', audience: 'a', constraints: 'c' },
    research: { summary: 's', candidateSkills: ['sk'], candidateTools: [] },
    equipment: { enabledPlugins: ['plg_x'], missingCapabilities: [] },
    staffing: { employeeIds: ['ag_x'] },
    notes: '',
  });
}

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  const company = restoreWorkbench(db, { id: 'wb_fix_1', name: '测试公司' });
  companyId = company.id;
});

afterEach(() => tdb.close());

function makeDraftingProject(): string {
  const project = createProject(db, { companyId, name: '测试项目', rootDir: makeTempGitRepo() });
  return project.id;
}

describe('createProject 默认 drafting', () => {
  it('新建项目 state 为 drafting', () => {
    const id = makeDraftingProject();
    expect(getProject(db, id).state).toBe('drafting');
  });

  it('initialState 参数可跳过准备流程', () => {
    const project = createProject(db, {
      companyId,
      name: '直接开工',
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    expect(project.state).toBe('active');
  });
});

describe('assertCanTransition 合法转换', () => {
  it('准备阶段顺序推进', () => {
    expect(() => assertCanTransition('drafting', 'researching')).not.toThrow();
    expect(() => assertCanTransition('researching', 'equipping')).not.toThrow();
    expect(() => assertCanTransition('equipping', 'staffing')).not.toThrow();
    expect(() => assertCanTransition('staffing', 'ready')).not.toThrow();
    expect(() => assertCanTransition('ready', 'active')).not.toThrow();
  });

  it('允许回流（任意前序阶段）', () => {
    expect(() => assertCanTransition('staffing', 'drafting')).not.toThrow();
    expect(() => assertCanTransition('ready', 'researching')).not.toThrow();
    expect(() => assertCanTransition('active', 'equipping')).not.toThrow();
    expect(() => assertCanTransition('researching', 'drafting')).not.toThrow();
  });

  it('active ↔ paused 双向', () => {
    expect(() => assertCanTransition('active', 'paused')).not.toThrow();
    expect(() => assertCanTransition('paused', 'active')).not.toThrow();
  });

  it('idle → drafting 兼容历史', () => {
    expect(() => assertCanTransition('idle', 'drafting')).not.toThrow();
  });

  it('active/paused → completed', () => {
    expect(() => assertCanTransition('active', 'completed')).not.toThrow();
    expect(() => assertCanTransition('paused', 'completed')).not.toThrow();
  });

  it('任意非终态 → archived', () => {
    expect(() => assertCanTransition('drafting', 'archived')).not.toThrow();
    expect(() => assertCanTransition('active', 'archived')).not.toThrow();
    expect(() => assertCanTransition('paused', 'archived')).not.toThrow();
  });

  it('同态转换无操作', () => {
    expect(() => assertCanTransition('drafting', 'drafting')).not.toThrow();
    expect(() => assertCanTransition('active', 'active')).not.toThrow();
  });
});

describe('assertCanTransition 非法转换', () => {
  it('跳过阶段被拒绝（drafting 不能直接到 active/equipping/staffing）', () => {
    expect(() => assertCanTransition('drafting', 'active')).toThrow(AppError);
    expect(() => assertCanTransition('drafting', 'equipping')).toThrow(AppError);
    expect(() => assertCanTransition('drafting', 'staffing')).toThrow(AppError);
  });

  it('准备阶段直接跳 active 被拒绝', () => {
    expect(() => assertCanTransition('researching', 'active')).toThrow(AppError);
    expect(() => assertCanTransition('equipping', 'active')).toThrow(AppError);
  });

  it('idle 直接跳 active 被拒绝', () => {
    expect(() => assertCanTransition('idle', 'active')).toThrow(AppError);
  });

  it('drafting 不能跳到 paused（开工前不能暂停）', () => {
    expect(() => assertCanTransition('drafting', 'paused')).toThrow(AppError);
  });

  it('错误码为 TASK_INVALID_TRANSITION', () => {
    try {
      assertCanTransition('drafting', 'active');
      expect.fail('应抛错');
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.TASK_INVALID_TRANSITION);
    }
  });
});

describe('transitionProjectPhase', () => {
  it('向前跃迁成功并返回 previousState', () => {
    const id = makeDraftingProject();
    fillReadiness(db, id);
    const { project, previousState } = transitionProjectPhase(db, id, 'researching');
    expect(project.state).toBe('researching');
    expect(previousState).toBe('drafting');
  });

  it('回流跃迁成功（不需要 readiness）', () => {
    const id = makeDraftingProject();
    fillReadiness(db, id);
    transitionProjectPhase(db, id, 'researching');
    const { project, previousState } = transitionProjectPhase(db, id, 'drafting');
    expect(project.state).toBe('drafting');
    expect(previousState).toBe('researching');
  });

  it('非法跃迁抛错（项目状态不变）', () => {
    const id = makeDraftingProject();
    expect(() => transitionProjectPhase(db, id, 'active')).toThrow(AppError);
    expect(getProject(db, id).state).toBe('drafting'); // 状态未被改
  });

  it('向前跃迁缺产物被 validatePhaseExit 拦截', () => {
    const id = makeDraftingProject();
    // 不填 readiness，drafting→researching 缺 goal
    expect(() => transitionProjectPhase(db, id, 'researching')).toThrow(AppError);
  });

  it('走完整准备流程到 active', () => {
    const id = makeDraftingProject();
    fillReadiness(db, id);
    for (const target of ['researching', 'equipping', 'staffing', 'ready', 'active'] as ProjectState[]) {
      transitionProjectPhase(db, id, target);
    }
    expect(getProject(db, id).state).toBe('active');
  });
});

describe('assertProjectActive 派工闸门', () => {
  it('drafting 项目派工被拒', () => {
    const id = makeDraftingProject();
    expect(() => assertProjectActive(db, id)).toThrow(AppError);
    try {
      assertProjectActive(db, id);
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.PROJECT_INACTIVE);
    }
  });

  it('各准备阶段派工均被拒', () => {
    const id = makeDraftingProject();
    fillReadiness(db, id);
    for (const target of ['researching', 'equipping', 'staffing', 'ready'] as ProjectState[]) {
      transitionProjectPhase(db, id, target);
      expect(() => assertProjectActive(db, id)).toThrow(AppError);
    }
  });

  it('active 项目派工放行', () => {
    const id = makeDraftingProject();
    fillReadiness(db, id);
    for (const target of ['researching', 'equipping', 'staffing', 'ready', 'active'] as ProjectState[]) {
      transitionProjectPhase(db, id, target);
    }
    expect(() => assertProjectActive(db, id)).not.toThrow();
  });

  it('initialState=active 的项目直接放行', () => {
    const project = createProject(db, {
      companyId,
      name: '直接开工',
      rootDir: makeTempGitRepo(),
      initialState: 'active',
    });
    expect(() => assertProjectActive(db, project.id)).not.toThrow();
  });
});
