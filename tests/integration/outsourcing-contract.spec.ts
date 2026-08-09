/**
 * B2B 外包契约生命周期测试：创建 → 接受 → 执行 → 交付 → 验收（含返工）→ 完成。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import {
  createOutsourcingContract,
  acceptContract,
  createOutsourcedTask,
  markDelivered,
  submitReview,
  cancelContract,
  getOutsourcingContract,
  listContractsForCompany,
  createReworkTask,
} from '../../src/server/domain/outsourcing-contract';

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
  companyA = createCompany(db, { name: '甲方游戏公司' }).id;
  companyB = createCompany(db, { name: '乙方设计公司' }).id;
  agentA = createAgent(db, {
    companyId: companyA,
    name: '甲方负责人',
    role: 'lead',
    responsibilities: '运营',
    systemPrompt: '',
    skills: [],
    tools: [],
    permissions: {},
    contactAllow: [],
    canDispatch: true,
    executor: {},
    isInspector: false,
    stance: '',
  }).id;
  agentB = createAgent(db, {
    companyId: companyB,
    name: '乙方设计师',
    role: 'designer',
    responsibilities: '美术设计',
    systemPrompt: '',
    skills: [],
    tools: [],
    permissions: {},
    contactAllow: [],
    canDispatch: true,
    executor: {},
    isInspector: false,
    stance: '',
  }).id;
  // 上线
  db.prepare("UPDATE company SET state='online', first_agent_id=? WHERE id=?").run(agentA, companyA);
  db.prepare("UPDATE company SET state='online', first_agent_id=? WHERE id=?").run(agentB, companyB);
  db.prepare("UPDATE agent_definition SET availability_state='online' WHERE id IN (?,?)").run(agentA, agentB);
  // 甲方项目（active 态）
  projectA = createProject(db, {
    companyId: companyA,
    name: '游戏素材项目',
    initialState: 'active',
  }).id;
});

afterEach(() => tdb.close());

describe('外包契约：创建与基础查询', () => {
  it('创建 pending 态契约', () => {
    const c = createOutsourcingContract(db, {
      sourceCompanyId: companyA,
      targetCompanyId: companyB,
      sourceProjectId: projectA,
      title: 'UI 原型设计',
      brief: '需要 5 张游戏角色 UI 原型',
      acceptanceCriteria: [{ id: 'ac1', criterion: '交付 5 张 PSD' }],
      requiredCapabilityIds: ['ui-design'],
    });
    expect(c.state).toBe('pending');
    expect(c.sourceCompanyId).toBe(companyA);
    expect(c.targetCompanyId).toBe(companyB);
    expect(c.acceptanceCriteria).toHaveLength(1);
  });

  it('不能向自身公司外包', () => {
    expect(() =>
      createOutsourcingContract(db, {
        sourceCompanyId: companyA,
        targetCompanyId: companyA,
        sourceProjectId: projectA,
        title: 'x',
        brief: 'x',
      }),
    ).toThrow(/自身公司/);
  });

  it('按角色列出契约', () => {
    createOutsourcingContract(db, {
      sourceCompanyId: companyA,
      targetCompanyId: companyB,
      sourceProjectId: projectA,
      title: 'A',
      brief: 'a',
    });
    expect(listContractsForCompany(db, companyA, 'source')).toHaveLength(1);
    expect(listContractsForCompany(db, companyB, 'target')).toHaveLength(1);
    expect(listContractsForCompany(db, companyA, 'target')).toHaveLength(0);
  });
});

describe('外包契约：接受 + 承接任务创建（跨公司）', () => {
  it('乙方接受后契约进 accepted，创建承接任务后进 in_progress', () => {
    const c = createOutsourcingContract(db, {
      sourceCompanyId: companyA,
      targetCompanyId: companyB,
      sourceProjectId: projectA,
      title: '角色设计',
      brief: '设计主角',
      dispatcherAgentId: agentA,
    });
    const accepted = acceptContract(db, c.id, agentB);
    expect(accepted.state).toBe('accepted');
    expect(accepted.vendorLiaisonAgentId).toBe(agentB);
    // 创建承接任务（跨公司，绕过同公司守卫）
    const { task } = createOutsourcedTask(db, c.id);
    expect(task.assigneeAgentId).toBe(agentB);
    expect(task.outsourcingContractId).toBe(c.id);
    // 契约进 in_progress，outsourcedTaskId 回填
    const inProgress = getOutsourcingContract(db, c.id);
    expect(inProgress.state).toBe('in_progress');
    expect(inProgress.outsourcedTaskId).toBe(task.id);
  });

  it('对接人不属于乙方时拒绝', () => {
    const c = createOutsourcingContract(db, {
      sourceCompanyId: companyA,
      targetCompanyId: companyB,
      sourceProjectId: projectA,
      title: 'x',
      brief: 'x',
    });
    expect(() => acceptContract(db, c.id, agentA)).toThrow(/不属于乙方公司/);
  });
});

describe('外包契约：验收流转（completed / changes_requested / rejected）', () => {
  it('验收通过 → completed', () => {
    let c = createOutsourcingContract(db, {
      sourceCompanyId: companyA,
      targetCompanyId: companyB,
      sourceProjectId: projectA,
      title: 'x',
      brief: 'x',
    });
    acceptContract(db, c.id, agentB);
    createOutsourcedTask(db, c.id);
    markDelivered(db, c.id);
    c = getOutsourcingContract(db, c.id);
    expect(c.state).toBe('delivered');
    const done = submitReview(db, c.id, 'completed', '质量很好');
    expect(done.state).toBe('completed');
    expect(done.feedback).toBe('质量很好');
  });

  it('验收返工 → changes_requested → in_progress，revisionRound++，创建返工任务', () => {
    let c = createOutsourcingContract(db, {
      sourceCompanyId: companyA,
      targetCompanyId: companyB,
      sourceProjectId: projectA,
      title: 'x',
      brief: 'x',
      acceptanceCriteria: [{ id: 'ac1', criterion: '验收点1' }],
    });
    acceptContract(db, c.id, agentB);
    createOutsourcedTask(db, c.id);
    markDelivered(db, c.id);
    // 返工
    submitReview(db, c.id, 'changes_requested', '颜色不对');
    c = getOutsourcingContract(db, c.id);
    expect(c.state).toBe('in_progress');
    expect(c.revisionRound).toBe(1);
    expect(c.feedback).toBe('颜色不对');
    // 创建返工任务（继承验收标准）
    const rework = createReworkTask(db, c.id, '颜色不对');
    expect(rework.acceptanceCriteria).toHaveLength(1);
    expect(rework.outsourcingContractId).toBe(c.id);
    // outsourcedTaskId 更新为返工任务
    expect(getOutsourcingContract(db, c.id).outsourcedTaskId).toBe(rework.id);
  });

  it('验收拒绝 → rejected（终态）', () => {
    let c = createOutsourcingContract(db, {
      sourceCompanyId: companyA,
      targetCompanyId: companyB,
      sourceProjectId: projectA,
      title: 'x',
      brief: 'x',
    });
    acceptContract(db, c.id, agentB);
    createOutsourcedTask(db, c.id);
    markDelivered(db, c.id);
    c = getOutsourcingContract(db, c.id);
    const rejected = submitReview(db, c.id, 'rejected', '完全不符合要求');
    expect(rejected.state).toBe('rejected');
  });
});

describe('外包契约：取消', () => {
  it('pending 态可取消', () => {
    const c = createOutsourcingContract(db, {
      sourceCompanyId: companyA,
      targetCompanyId: companyB,
      sourceProjectId: projectA,
      title: 'x',
      brief: 'x',
    });
    expect(cancelContract(db, c.id).state).toBe('cancelled');
  });

  it('completed 终态不可取消', () => {
    const c = createOutsourcingContract(db, {
      sourceCompanyId: companyA,
      targetCompanyId: companyB,
      sourceProjectId: projectA,
      title: 'x',
      brief: 'x',
    });
    acceptContract(db, c.id, agentB);
    createOutsourcedTask(db, c.id);
    markDelivered(db, c.id);
    submitReview(db, c.id, 'completed');
    expect(() => cancelContract(db, c.id)).toThrow(/终态/);
  });
});
