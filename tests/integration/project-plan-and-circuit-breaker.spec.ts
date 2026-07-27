/**
 * B5 编排测试：
 * - PlanVersion CRUD（createPlanVersion/getActive/list，version 自增 + supersede）
 * - phase history（recordPhaseEnter/listPhaseHistory，含回流标记）
 * - 熔断：failTask 自增 failureCount，≥3 触发项目回流
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject, type ProjectState } from '../../src/server/domain/project';
import {
  createPlanVersion,
  getActivePlanVersion,
  listPlanVersions,
  recordPhaseEnter,
  listPhaseHistory,
} from '../../src/server/domain/project-plan';
import {
  getProjectReadiness,
  setProjectReadiness,
} from '../../src/server/domain/project-onboarding';
import { transitionProjectPhase } from '../../src/server/domain/project-readiness';
import { createTask, failTask } from '../../src/server/domain/task';
import { TASK_CIRCUIT_BREAKER_THRESHOLD } from '../../src/shared/constants';
import { emptyProjectReadiness } from '../../src/shared/project-readiness';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;
let projectId: string;
let agentId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  companyId = createCompany(db, { name: 'co' }).id;
  agentId = createAgent(db, { companyId, name: 'lead', role: 'lead' }).id;
  projectId = createProject(db, {
    companyId,
    name: 'p',
    rootDir: makeTempGitRepo(),
    firstAgentId: agentId,
    initialState: 'active',
  }).id;
});

afterEach(() => tdb.close());

function fillReadiness(db2: DB, id: string): void {
  setProjectReadiness(db2, id, {
    draft: { goal: 'g', audience: '', constraints: '' },
    research: { summary: 's', candidateSkills: ['sk'], candidateTools: [] },
    equipment: { enabledPlugins: ['plg_x'], missingCapabilities: [] },
    staffing: { employeeIds: [agentId] },
    notes: '',
  });
}

describe('PlanVersion CRUD', () => {
  it('首次创建 version=1，无 parent', () => {
    const plan = createPlanVersion(db, projectId, { createdReason: 'initial' });
    expect(plan.version).toBe(1);
    expect(plan.parentVersion).toBeNull();
    expect(plan.status).toBe('active');
    expect(plan.createdReason).toBe('initial');
  });

  it('第二次创建 version=2，旧 active 转 superseded', () => {
    createPlanVersion(db, projectId, { createdReason: 'initial' });
    const plan2 = createPlanVersion(db, projectId, { createdReason: 'rollback-3x' });
    expect(plan2.version).toBe(2);
    expect(plan2.parentVersion).toBe(1);
    const active = getActivePlanVersion(db, projectId);
    expect(active?.version).toBe(2);
    const all = listPlanVersions(db, projectId);
    expect(all).toHaveLength(2);
    expect(all.find((p) => p.version === 1)?.status).toBe('superseded');
  });

  it('listPlanVersions 倒序', () => {
    createPlanVersion(db, projectId);
    createPlanVersion(db, projectId);
    createPlanVersion(db, projectId);
    const all = listPlanVersions(db, projectId);
    expect(all.map((p) => p.version)).toEqual([3, 2, 1]);
  });
});

describe('phase history', () => {
  it('recordPhaseEnter 插入记录', () => {
    recordPhaseEnter(db, projectId, 'drafting');
    const history = listPhaseHistory(db, projectId);
    expect(history).toHaveLength(1);
    expect(history[0]!.phase).toBe('drafting');
    expect(history[0]!.enteredAt).toBeTruthy();
    expect(history[0]!.exitedAt).toBeNull();
  });

  it('连续进入新 phase 时关闭上一条', () => {
    recordPhaseEnter(db, projectId, 'drafting');
    recordPhaseEnter(db, projectId, 'researching');
    const history = listPhaseHistory(db, projectId);
    expect(history).toHaveLength(2);
    const drafting = history.find((h) => h.phase === 'drafting')!;
    expect(drafting.exitedAt).not.toBeNull();
    expect(drafting.outcome).toBe('forward');
  });

  it('回流标记 rollbackFrom', () => {
    recordPhaseEnter(db, projectId, 'researching');
    recordPhaseEnter(db, projectId, 'drafting', { rollbackFrom: 'researching' });
    const history = listPhaseHistory(db, projectId);
    const drafting = history.find((h) => h.phase === 'drafting')!;
    expect(drafting.rollbackFrom).toBe('researching');
    const researching = history.find((h) => h.phase === 'researching')!;
    expect(researching.outcome).toBe('rollback');
  });

  it('transitionProjectPhase 内自动记录 phase history', () => {
    // 项目初始 active，先降到 drafting 模拟回流测试
    // 用 db 直接改 state 到 drafting 绕过 validatePhaseExit
    db.prepare("UPDATE project SET state='drafting' WHERE id=?").run(projectId);
    fillReadiness(db, projectId);
    transitionProjectPhase(db, projectId, 'researching');
    const history = listPhaseHistory(db, projectId);
    expect(history.some((h) => h.phase === 'researching')).toBe(true);
  });
});

describe('熔断回流', () => {
  it('failTask 自增 failureCount', () => {
    const task = createTask(db, {
      projectId,
      title: 't',
      assigneeAgentId: agentId,
    });
    expect(task.failureCount).toBe(0);
    const t1 = failTask(db, task.id, 'err1');
    expect(t1.failureCount).toBe(1);
    expect(t1.lastFailedAt).toBeTruthy();
    const t2 = failTask(db, task.id, 'err2');
    expect(t2.failureCount).toBe(2);
  });

  it('熔断阈值常量是 3', () => {
    expect(TASK_CIRCUIT_BREAKER_THRESHOLD).toBe(3);
  });

  it('失败 3 次后项目应回流（模拟 engine 熔断逻辑）', () => {
    // 项目当前 active，建 task 失败 3 次
    const task = createTask(db, { projectId, title: 't', assigneeAgentId: agentId });
    failTask(db, task.id, 'err1');
    failTask(db, task.id, 'err2');
    const failed = failTask(db, task.id, 'err3');
    expect(failed.failureCount).toBe(3);

    // 模拟 engine 熔断逻辑：failureCount >= 阈值 且 active → 回流到 researching
    const project = db.prepare('SELECT state FROM project WHERE id=?').get(projectId) as { state: string };
    expect(project.state).toBe('active'); // 项目刚建时 active
    if (failed.failureCount >= TASK_CIRCUIT_BREAKER_THRESHOLD && project.state === 'active') {
      // 回流是 active→researching（toIdx<fromIdx），validatePhaseExit 不校验产物
      transitionProjectPhase(db, projectId, 'researching');
    }
    const after = db.prepare('SELECT state FROM project WHERE id=?').get(projectId) as { state: string };
    expect(after.state).toBe('researching');
  });
});
