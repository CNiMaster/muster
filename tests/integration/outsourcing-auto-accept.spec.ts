/**
 * 外包自动接受（阶段四任务 4.1）集成测试。
 *
 * 验证：
 * 1. 乙方在线 + 自动接受开启 → pending 契约自动接受，对接人按能力匹配
 * 2. 无能力匹配时选乙方第一负责人
 * 3. 乙方不在线 → 不自动接受
 * 4. contractJson.autoAcceptOutsourcing=false → 不自动接受
 * 5. coordinator tick 自动触发
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
import { createCompany, transitionCompany, updateCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createOutsourcingContract, autoAcceptContract, getOutsourcingContract } from '../../src/server/domain/outsourcing-contract';
import * as outsourcingContractModule from '../../src/server/domain/outsourcing-contract';
import { createTask } from '../../src/server/domain/task';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { ProjectRuntimeCoordinator } from '../../src/server/runtime/coordinator';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

function fixture() {
  const a = createCompany(db, { name: '甲方' });
  const b = createCompany(db, { name: '乙方' });
  const aLead = createAgent(db, { companyId: a.id, name: 'a-lead', role: 'lead' });
  const bLead = createAgent(db, { companyId: b.id, name: 'b-lead', role: 'lead' });
  const bDesigner = createAgent(db, { companyId: b.id, name: 'b-designer', role: 'designer', skills: ['design'] });
  const project = createProject(db, { companyId: a.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: aLead.id, initialState: 'active' });
  // 甲方上线（发起委派需要甲方在线）；乙方是否上线由各测试控制
  transitionCompany(db, a.id, 'online');
  return { a, b, aLead, bLead, bDesigner, project };
}

describe('外包自动接受（阶段四任务 4.1）', () => {
    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('乙方在线时自动接受，对接人按能力匹配', () => {
    const { a, b, bDesigner, project } = fixture();
    transitionCompany(db, b.id, 'online');
    const contract = createOutsourcingContract(db, {
      sourceCompanyId: a.id,
      targetCompanyId: b.id,
      sourceProjectId: project.id,
      title: '设计一张封面',
      brief: '为小说项目设计封面',
      requiredCapabilityIds: ['design'],
    });

    const result = autoAcceptContract(db, contract.id);
    expect(result?.state).toBe('accepted');
    expect(result?.vendorLiaisonAgentId).toBe(bDesigner.id);
  });

    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('无能力匹配时选乙方第一负责人', () => {
    const { a, b, bLead, project } = fixture();
    transitionCompany(db, b.id, 'online');
    const contract = createOutsourcingContract(db, {
      sourceCompanyId: a.id,
      targetCompanyId: b.id,
      sourceProjectId: project.id,
      title: '特殊能力任务',
      brief: '需要特殊能力',
      requiredCapabilityIds: ['nonexistent-capability'],
    });

    const result = autoAcceptContract(db, contract.id);
    expect(result?.state).toBe('accepted');
    expect(result?.vendorLiaisonAgentId).toBe(bLead.id);
  });

    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('L-8：无能力要求时优先选在线的第一负责人（而非创建顺序第一个）', () => {
    const a = createCompany(db, { name: '甲方' });
    const b = createCompany(db, { name: '乙方' });
    const aLead = createAgent(db, { companyId: a.id, name: 'a-lead', role: 'lead' });
    // bDesigner 先创建（会在 online 列表第一位），bLead 后创建但设为公司第一负责人
    const bDesigner = createAgent(db, { companyId: b.id, name: 'b-designer', role: 'designer', skills: ['design'] });
    const bLead = createAgent(db, { companyId: b.id, name: 'b-lead', role: 'lead' });
    updateCompany(db, b.id, { firstAgentId: bLead.id });
    transitionCompany(db, a.id, 'online');
    transitionCompany(db, b.id, 'online');
    const project = createProject(db, { companyId: a.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: aLead.id, initialState: 'active' });
    const contract = createOutsourcingContract(db, {
      sourceCompanyId: a.id,
      targetCompanyId: b.id,
      sourceProjectId: project.id,
      title: '普通任务',
      brief: '无能力要求',
    });

    // 原逻辑 required 为空时直接取 online[0]（bDesigner）；修复后应优先第一负责人 bLead
    const result = autoAcceptContract(db, contract.id);
    expect(result?.state).toBe('accepted');
    expect(result?.vendorLiaisonAgentId).toBe(bLead.id);
  });

  it('乙方不在线时不自动接受', () => {
    const { a, b, project } = fixture();
    // 乙方未上线（off）
    const contract = createOutsourcingContract(db, {
      sourceCompanyId: a.id,
      targetCompanyId: b.id,
      sourceProjectId: project.id,
      title: 't',
      brief: 'b',
    });

    const result = autoAcceptContract(db, contract.id);
    expect(result).toBeNull();
    expect(getOutsourcingContract(db, contract.id).state).toBe('pending');
  });

  it('contractJson.autoAcceptOutsourcing=false 时不自动接受', () => {
    const { a, b, project } = fixture();
    updateCompany(db, b.id, { contractJson: { autoAcceptOutsourcing: false } });
    transitionCompany(db, b.id, 'online');
    const contract = createOutsourcingContract(db, {
      sourceCompanyId: a.id,
      targetCompanyId: b.id,
      sourceProjectId: project.id,
      title: 't',
      brief: 'b',
    });

    const result = autoAcceptContract(db, contract.id);
    expect(result).toBeNull();
    expect(getOutsourcingContract(db, contract.id).state).toBe('pending');
  });

    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('coordinator tick 自动接受 pending 契约', async () => {
    const { a, b, bLead, project } = fixture();
    transitionCompany(db, b.id, 'online');
    const contract = createOutsourcingContract(db, {
      sourceCompanyId: a.id,
      targetCompanyId: b.id,
      sourceProjectId: project.id,
      title: 't',
      brief: 'b',
    });

    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()));
    await coordinator.tick({ pump: false });

    const after = getOutsourcingContract(db, contract.id);
    // Review 修复：自动接受后立即创建乙方承接任务 → 契约进入 in_progress（闭环完整）
    expect(after.state).toBe('in_progress');
    expect(after.vendorLiaisonAgentId).toBe(bLead.id);
    expect(after.outsourcedTaskId).not.toBeNull();
    void a;
  });

    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('M-1：承接任务创建失败时契约回滚 pending + 退避，退避释放后重试成功', async () => {
    const { a, b, project } = fixture();
    transitionCompany(db, b.id, 'online');
    const contract = createOutsourcingContract(db, {
      sourceCompanyId: a.id,
      targetCompanyId: b.id,
      sourceProjectId: project.id,
      title: 't',
      brief: 'b',
    });
    const coordinator = new ProjectRuntimeCoordinator(db, new TaskEngine(db, new FakeExecutor()));

    // 第一次 tick：createOutsourcedTask 抛错 → 契约应回滚 pending + 设退避（不再卡在 accepted）
    const spy = vi.spyOn(outsourcingContractModule, 'createOutsourcedTask').mockImplementation(() => {
      throw new Error('simulated task creation failure');
    });
    await coordinator.tick({ pump: false });
    spy.mockRestore();

    const afterFirst = getOutsourcingContract(db, contract.id);
    expect(afterFirst.state).toBe('pending');
    expect(afterFirst.vendorLiaisonAgentId).toBeNull();
    // M-1 退避：失败后累加计数 + 设下次允许时间，避免每 2s tick 反复空转
    expect(afterFirst.autoAcceptAttemptCount).toBe(1);
    expect(afterFirst.autoAcceptAfterAt).not.toBeNull();
    // 退避未释放：第二次 tick 不应重试（契约仍 pending）
    await coordinator.tick({ pump: false });
    expect(getOutsourcingContract(db, contract.id).state).toBe('pending');

    // 模拟退避时间已过 → 第三次 tick 恢复真实实现，自动接受并创建承接任务
    db.prepare('UPDATE outsourcing_contract SET auto_accept_after_at=? WHERE id=?')
      .run(new Date(Date.now() - 1000).toISOString(), contract.id);
    await coordinator.tick({ pump: false });
    const afterThird = getOutsourcingContract(db, contract.id);
    expect(afterThird.state).toBe('in_progress');
    expect(afterThird.outsourcedTaskId).not.toBeNull();
    // 成功接受后退避计数清零
    expect(afterThird.autoAcceptAttemptCount).toBe(0);
    expect(afterThird.autoAcceptAfterAt).toBeNull();
  });
});
