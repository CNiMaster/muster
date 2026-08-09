/**
 * B2B 外包决策树测试：内部能做 → 外包 → 招聘 三路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { nowIso, shortId } from '../../src/shared/utils';
import {
  hasInternalCapability,
  findVendorCompany,
  runOutsourcingDecisionTree,
} from '../../src/server/domain/outsourcing-decision';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyA: string; // 甲方
let companyB: string; // 乙方（设计公司）
let agentA: string;
let agentB: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  companyA = createCompany(db, { name: '游戏公司' }).id;
  companyB = createCompany(db, { name: '设计公司' }).id;
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
  // clock-in 让公司上线
  db.prepare("UPDATE company SET state='online', first_agent_id=? WHERE id=?").run(agentA, companyA);
  db.prepare("UPDATE company SET state='online', first_agent_id=? WHERE id=?").run(agentB, companyB);
  db.prepare("UPDATE agent_definition SET availability_state='online' WHERE id IN (?,?)").run(agentA, agentB);
});

afterEach(() => tdb.close());

/** 插入一条 capability_binding（员工级）。 */
function bindCapability(companyId: string, employeeId: string, capabilityId: string): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO capability_binding
      (id, company_id, employee_id, scope, scope_key, capability_id, skill_ids_json,
       recommended_tool_ids_json, requires_executor_kind, purpose, load_when, created_at, updated_at)
     VALUES (?,?,?,'employee',?,?,'[]','[]','','test','always',?,?)`,
  ).run(shortId('cb_'), companyId, employeeId, employeeId, capabilityId, now, now);
}

describe('决策树：hasInternalCapability', () => {
  it('公司内有员工绑定该能力 → true', () => {
    bindCapability(companyA, agentA, 'game-art-design');
    expect(hasInternalCapability(db, companyA, ['game-art-design'])).toBe(true);
  });

  it('公司内无员工绑定该能力 → false', () => {
    bindCapability(companyB, agentB, 'game-art-design'); // 只有乙方有
    expect(hasInternalCapability(db, companyA, ['game-art-design'])).toBe(false);
  });

  it('无能力要求 → 视为内部可做', () => {
    expect(hasInternalCapability(db, companyA, [])).toBe(true);
  });
});

describe('决策树：findVendorCompany', () => {
  it('找到具备能力的乙方公司（排除自身）', () => {
    bindCapability(companyB, agentB, 'game-art-design');
    const vendor = findVendorCompany(db, companyA, ['game-art-design']);
    expect(vendor).not.toBeNull();
    expect(vendor!.id).toBe(companyB);
  });

  it('系统内无公司具备该能力 → null', () => {
    const vendor = findVendorCompany(db, companyA, ['nonexistent-cap']);
    expect(vendor).toBeNull();
  });
});

describe('决策树：runOutsourcingDecisionTree 三路径', () => {
  it('路径 internal：甲方内部有能力', () => {
    bindCapability(companyA, agentA, 'game-art-design');
    const decision = runOutsourcingDecisionTree(db, companyA, ['game-art-design']);
    expect(decision.path).toBe('internal');
    expect(decision.internalAssigneeId).toBe(agentA);
    expect(decision.missingCapabilityIds).toEqual([]);
  });

  it('路径 outsource：甲方无能力，乙方有', () => {
    bindCapability(companyB, agentB, 'game-art-design');
    const decision = runOutsourcingDecisionTree(db, companyA, ['game-art-design']);
    expect(decision.path).toBe('outsource');
    expect(decision.vendorCompany?.id).toBe(companyB);
    expect(decision.missingCapabilityIds).toEqual(['game-art-design']);
  });

  it('路径 recruit：系统内均无能力', () => {
    const decision = runOutsourcingDecisionTree(db, companyA, ['rare-capability']);
    expect(decision.path).toBe('recruit');
    expect(decision.vendorCompany).toBeUndefined();
    expect(decision.missingCapabilityIds).toEqual(['rare-capability']);
  });
});
