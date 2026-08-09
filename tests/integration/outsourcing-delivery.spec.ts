/**
 * B2B 外包交付测试：承接任务 worktree 基于甲方 repo、跨公司依赖恢复、交付触发。
 *
 * 验证：
 * 1. outsourcingContext 绕过同公司守卫，承接任务可跨公司创建
 * 2. resumeDependents 能唤醒因依赖外包任务而 waiting_dependency 的甲方任务
 * 3. onOutsourcedTaskCompleted 把契约标记 delivered（幂等）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, completeTask, addDependency, resumeDependents, type Task } from '../../src/server/domain/task';
import {
  createOutsourcingContract,
  acceptContract,
  createOutsourcedTask,
  markDelivered,
  getOutsourcingContract,
} from '../../src/server/domain/outsourcing-contract';
import { onOutsourcedTaskCompleted } from '../../src/server/domain/outsourcing-delivery';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyA: string;
let companyB: string;
let agentA: string;
let agentB: string;
let projectA: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  companyA = createCompany(db, { name: '甲方' }).id;
  companyB = createCompany(db, { name: '乙方' }).id;
  agentA = createAgent(db, {
    companyId: companyA, name: '甲负责人', role: 'lead', responsibilities: '', systemPrompt: '',
    skills: [], tools: [], permissions: {}, contactAllow: [], canDispatch: true, executor: {}, isInspector: false, stance: '',
  }).id;
  agentB = createAgent(db, {
    companyId: companyB, name: '乙设计师', role: 'designer', responsibilities: '', systemPrompt: '',
    skills: [], tools: [], permissions: {}, contactAllow: [], canDispatch: true, executor: {}, isInspector: false, stance: '',
  }).id;
  db.prepare("UPDATE company SET state='online', first_agent_id=? WHERE id=?").run(agentA, companyA);
  db.prepare("UPDATE company SET state='online', first_agent_id=? WHERE id=?").run(agentB, companyB);
  db.prepare("UPDATE agent_definition SET availability_state='online' WHERE id IN (?,?)").run(agentA, agentB);
  projectA = createProject(db, { companyId: companyA, name: '甲方项目', initialState: 'active' }).id;
});

afterEach(() => tdb.close());

describe('外包交付：跨公司任务创建绕过守卫', () => {
  it('outsourcingContext 允许乙方 agent 作为承接任务 assignee', () => {
    const c = createOutsourcingContract(db, {
      sourceCompanyId: companyA, targetCompanyId: companyB, sourceProjectId: projectA,
      title: '设计', brief: '做设计',
    });
    acceptContract(db, c.id, agentB);
    const { task } = createOutsourcedTask(db, c.id);
    // 承接任务 assignee 是乙方 agent（跨公司），outsourcingContext 绕过了守卫
    expect(task.assigneeAgentId).toBe(agentB);
    expect(task.outsourcingContractId).toBe(c.id);
  });

  it('普通 createTask（无 outsourcingContext）仍拦截跨公司 assignee', () => {
    // 甲方项目里直接给乙方 agent 派活，无外包上下文 → 应被守卫拦
    expect(() =>
      createTask(db, { projectId: projectA, title: 'x', assigneeAgentId: agentB }),
    ).toThrow(/不属于项目所在公司/);
  });
});

describe('外包交付：onOutsourcedTaskCompleted 幂等触发', () => {
  it('承接任务完成后，契约标记 delivered', () => {
    const c = createOutsourcingContract(db, {
      sourceCompanyId: companyA, targetCompanyId: companyB, sourceProjectId: projectA,
      title: '设计', brief: '做设计',
    });
    acceptContract(db, c.id, agentB);
    const { task } = createOutsourcedTask(db, c.id);
    // 模拟承接任务完成
    const result = onOutsourcedTaskCompleted(db, task.id);
    expect(result?.state).toBe('delivered');
  });

  it('非外包任务返回 null（无副作用）', () => {
    const normalTask = createTask(db, { projectId: projectA, title: '普通任务', assigneeAgentId: agentA });
    expect(onOutsourcedTaskCompleted(db, normalTask.id)).toBeNull();
  });

  it('重复调用幂等（已 delivered 不重复触发）', () => {
    const c = createOutsourcingContract(db, {
      sourceCompanyId: companyA, targetCompanyId: companyB, sourceProjectId: projectA,
      title: '设计', brief: '做设计',
    });
    acceptContract(db, c.id, agentB);
    const { task } = createOutsourcedTask(db, c.id);
    onOutsourcedTaskCompleted(db, task.id); // 第一次 → delivered
    const second = onOutsourcedTaskCompleted(db, task.id); // 第二次 → 幂等
    expect(second?.state).toBe('delivered');
  });
});

describe('外包交付：resumeDependents 跨公司依赖恢复', () => {
  it('甲方任务依赖乙方承接任务，乙方完成后甲方被唤醒', () => {
    // 甲方有一个等待乙方的设计产物的任务
    const waitingTask = createTask(db, {
      projectId: projectA,
      title: '集成设计素材',
      assigneeAgentId: agentA,
    });
    // 建立外包契约 + 承接任务
    const c = createOutsourcingContract(db, {
      sourceCompanyId: companyA, targetCompanyId: companyB, sourceProjectId: projectA,
      title: '设计', brief: '做设计',
    });
    acceptContract(db, c.id, agentB);
    const { task: outsourcedTask } = createOutsourcedTask(db, c.id);
    // 甲方任务依赖外包承接任务
    addDependency(db, waitingTask.id, outsourcedTask.id);
    // 手动把甲方任务置为 waiting_dependency（模拟等待态）
    db.prepare("UPDATE task SET state='waiting_dependency' WHERE id=?").run(waitingTask.id);
    // 乙方承接任务完成（标记 completed）→ resumeDependents 应唤醒甲方任务
    db.prepare("UPDATE task SET state='completed' WHERE id=?").run(outsourcedTask.id);
    const resumed = resumeDependents(db, outsourcedTask.id);
    expect(resumed).toContain(waitingTask.id);
    const after = db.prepare('SELECT state FROM task WHERE id=?').get(waitingTask.id) as { state: string };
    expect(after.state).toBe('queued');
  });
});
