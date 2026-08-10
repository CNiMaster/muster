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
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
import { createCompany, transitionCompany, updateCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createOutsourcingContract, autoAcceptContract, getOutsourcingContract } from '../../src/server/domain/outsourcing-contract';
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
  it('乙方在线时自动接受，对接人按能力匹配', () => {
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

  it('无能力匹配时选乙方第一负责人', () => {
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

  it('coordinator tick 自动接受 pending 契约', async () => {
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
    expect(after.state).toBe('accepted');
    expect(after.vendorLiaisonAgentId).toBe(bLead.id);
    void a;
  });
});
