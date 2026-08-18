/**
 * 用工决策树测试（蓝图组织批次5：B2B 拆件后——内部 / 临时工选拔 两路径）。
 * "跨公司找乙方"（findVendorCompany / outsource 路径）已退役：
 * 能力缺口统一走临时工选拔（组队/复用路径），不再产生公司对公司契约。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createCapabilityBinding } from '../../src/server/domain/capability-binding';
import {
  hasInternalCapability,
  runOutsourcingDecisionTree,
} from '../../src/server/domain/outsourcing-decision';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyA: string;
let agentA: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  companyA = createCompany(db, { name: '游戏公司' }).id;
  agentA = createAgent(db, {
    companyId: companyA,
    name: '负责人',
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
  db.prepare("UPDATE company SET state='online', first_agent_id=? WHERE id=?").run(agentA, companyA);
  db.prepare("UPDATE agent_definition SET availability_state='online' WHERE id = ?").run(agentA);
});

afterEach(() => tdb.close());

/** 插入一条 capability_binding（员工级）。 */
function bindCapability(employeeId: string, capabilityId: string): void {
  createCapabilityBinding(db, {
    employeeId,
    scope: 'employee',
    scopeKey: employeeId,
    capabilityId,
    purpose: 'test',
    loadWhen: 'always',
  });
}

describe('决策树：hasInternalCapability', () => {
  it('内部有员工绑定该能力 → true', () => {
    bindCapability(agentA, 'game-art-design');
    expect(hasInternalCapability(db, companyA, ['game-art-design'])).toBe(true);
  });

  it('内部无员工绑定该能力 → false', () => {
    expect(hasInternalCapability(db, companyA, ['game-art-design'])).toBe(false);
  });

  it('无能力要求 → 视为内部可做', () => {
    expect(hasInternalCapability(db, companyA, [])).toBe(true);
  });
});

describe('决策树：两路径（批次5 拆件后）', () => {
  it('路径 internal：工作台内部有能力', () => {
    bindCapability(agentA, 'game-art-design');
    const decision = runOutsourcingDecisionTree(db, companyA, ['game-art-design']);
    expect(decision.path).toBe('internal');
    expect(decision.internalAssigneeId).toBe(agentA);
    expect(decision.missingCapabilityIds).toEqual([]);
  });

  it('系统内无能力：recruit 临时工选拔', () => {
    const decision = runOutsourcingDecisionTree(db, companyA, ['rare-capability']);
    expect(decision.path).toBe('recruit');
    expect(decision.missingCapabilityIds).toEqual(['rare-capability']);
  });
});
