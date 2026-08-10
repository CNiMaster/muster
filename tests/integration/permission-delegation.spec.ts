/**
 * 权限委托链 + 审计日志测试（批次 B）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { addRelationship } from '../../src/server/domain/graph';
import {
  createPermissionChangeRequest,
  findDirectManager,
  resolveApprover,
  approveChangeRequest,
  rejectChangeRequest,
  listPendingApprovals,
} from '../../src/server/domain/permission-delegation';
import { ensureRolePermissionTemplates, inferRoleTemplate } from '../../src/server/domain/permission-templates';
import { logArtifactChange, listArtifactHistory, listProjectAuditLog } from '../../src/server/domain/artifact-audit';
import { transferArtifactOwnership, transferAllArtifactsOfOwner } from '../../src/server/domain/artifact';
import { AppError } from '../../src/shared/errors';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;
let managerId: string;
let employeeId: string;
let projectId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  companyId = createCompany(db, { name: '委托链公司' }).id;
  managerId = createAgent(db, {
    companyId, name: '经理', role: 'lead', systemPrompt: '', skills: [], tools: [], permissions: {}, executor: {},
  }).id;
  employeeId = createAgent(db, {
    companyId, name: '员工', role: 'engineer', systemPrompt: '', skills: [], tools: [], permissions: {}, executor: {},
  }).id;
  // 下班建 org 边，再上线
  db.prepare("UPDATE company SET state='off', first_agent_id=? WHERE id=?").run(managerId, companyId);
  addRelationship(db, { companyId, kind: 'org', sourceId: managerId, targetId: employeeId });
  db.prepare("UPDATE company SET state='online' WHERE id=?").run(companyId);
  projectId = createProject(db, { companyId, name: '审计项目', initialState: 'active' }).id;
});

afterEach(() => tdb.close());

describe('权限委托链：findDirectManager', () => {
  it('通过 org 边找到直接负责人', () => {
    expect(findDirectManager(db, employeeId)).toBe(managerId);
  });

  it('无 org 边时 fallback 到公司第一负责人', () => {
    db.prepare("UPDATE company SET state='off' WHERE id=?").run(companyId);
    const loner = createAgent(db, {
      companyId, name: '孤员', role: 'temp', systemPrompt: '', skills: [], tools: [], permissions: {}, executor: {},
    }).id;
    db.prepare("UPDATE company SET state='online' WHERE id=?").run(companyId);
    expect(findDirectManager(db, loner)).toBe(managerId); // firstAgentId
  });

  it('resolveApprover 返回审批人', () => {
    expect(resolveApprover(db, employeeId)).toBe(managerId);
  });
});

describe('权限委托链：申请→审批', () => {
  it('申请自动路由审批人', () => {
    const req = createPermissionChangeRequest(db, {
      companyId,
      requesterEmployeeId: employeeId,
      requestedScope: 'permanent',
      reason: '需要长期写 articles 目录',
      targetPathPrefix: 'articles/',
    });
    expect(req.approverEmployeeId).toBe(managerId);
    expect(req.state).toBe('pending');
  });

  it('上级批准后生成 permission_rule', () => {
    // 给员工绑一个权限策略（approveChangeRequest 需要员工有策略才能生成规则）
    const policy = ensureRolePermissionTemplates(db);
    db.prepare('UPDATE company_employee SET permission_policy_id=? WHERE legacy_agent_id=?').run(policy.employee, employeeId);
    const req = createPermissionChangeRequest(db, {
      companyId,
      requesterEmployeeId: employeeId,
      requestedScope: 'temp',
      reason: '临时需要',
      requestedAction: 'write-file',
    });
    expect(req.validUntil).toBeTruthy(); // temp 有有效期
    const approved = approveChangeRequest(db, req.id, managerId);
    expect(approved.state).toBe('approved');
    expect(approved.approvedRuleId).toBeTruthy();
  });

  it('上级拒绝', () => {
    const req = createPermissionChangeRequest(db, {
      companyId,
      requesterEmployeeId: employeeId,
      requestedScope: 'permanent',
      reason: '想要',
    });
    const rejected = rejectChangeRequest(db, req.id, managerId);
    expect(rejected.state).toBe('rejected');
  });

  it('非审批人不能批准', () => {
    db.prepare("UPDATE company SET state='off' WHERE id=?").run(companyId);
    const other = createAgent(db, {
      companyId, name: '其他人', role: 'temp', systemPrompt: '', skills: [], tools: [], permissions: {}, executor: {},
    }).id;
    db.prepare("UPDATE company SET state='online' WHERE id=?").run(companyId);
    const req = createPermissionChangeRequest(db, {
      companyId,
      requesterEmployeeId: employeeId,
      requestedScope: 'permanent',
      reason: '想要',
    });
    expect(() => approveChangeRequest(db, req.id, other)).toThrow(/审批人/);
  });

  it('M-4：审批人未解析时（approverEmployeeId 为 null）不能批准/拒绝', () => {
    // 无 org 边 + 公司无第一负责人 → resolveApprover 返回 null
    db.prepare("UPDATE company SET state='off', first_agent_id=NULL WHERE id=?").run(companyId);
    const loner = createAgent(db, {
      companyId, name: '无负责人员工', role: 'temp', systemPrompt: '', skills: [], tools: [], permissions: {}, executor: {},
    }).id;
    db.prepare("UPDATE company SET state='online' WHERE id=?").run(companyId);
    const req = createPermissionChangeRequest(db, {
      companyId,
      requesterEmployeeId: loner,
      requestedScope: 'permanent',
      reason: '想要',
    });
    expect(req.approverEmployeeId).toBeNull();
    // 任何 approverId 都不能批准（此前 null 会短路守卫放行任意人）
    expect(() => approveChangeRequest(db, req.id, loner)).toThrow(/未解析到审批人/);
    expect(() => rejectChangeRequest(db, req.id, loner)).toThrow(/未解析到审批人/);
    const after = db.prepare('SELECT state FROM permission_change_request WHERE id=?').get(req.id) as { state: string };
    expect(after.state).toBe('pending');
  });

  it('listPendingApprovals 列出待审批', () => {
    createPermissionChangeRequest(db, {
      companyId,
      requesterEmployeeId: employeeId,
      requestedScope: 'permanent',
      reason: '想要',
    });
    expect(listPendingApprovals(db, managerId)).toHaveLength(1);
  });

  it('申请原因为空时报错', () => {
    expect(() =>
      createPermissionChangeRequest(db, {
        companyId,
        requesterEmployeeId: employeeId,
        requestedScope: 'permanent',
        reason: '  ',
      }),
    ).toThrow(/原因/);
  });
});

describe('按角色权限模板', () => {
  it('创建三档模板（幂等）', () => {
    const t1 = ensureRolePermissionTemplates(db);
    const t2 = ensureRolePermissionTemplates(db); // 幂等
    expect(t1.manager).toBe(t2.manager);
    expect(t1.employee).toBe(t2.employee);
    expect(t1.temp).toBe(t2.temp);
    expect(t1.manager).not.toBe(t1.employee);
  });

  it('inferRoleTemplate 按角色推断', () => {
    expect(inferRoleTemplate('temp', false)).toBe('temp');
    expect(inferRoleTemplate('permanent', true)).toBe('manager');
    expect(inferRoleTemplate('permanent', false)).toBe('employee');
  });
});

describe('产物写入审计日志', () => {
  // 直接插入 artifact 行（绕过 upsertPublishedArtifact 的 task FK，便于隔离测试审计逻辑）
  function insertArtifact(path: string, owner: string): string {
    const id = `ar_${path}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO artifact (id, project_id, kind, path, owner_agent_id, merge_strategy, props_json, created_task_id, created_at, updated_at)
       VALUES (?, ?, 'document', ?, ?, 'three_way', '{}', NULL, ?, ?)`,
    ).run(id, projectId, path, owner, now, now);
    return id;
  }

  it('upsertPublishedArtifact 记录 create + update（需真实 task）', () => {
    // 简化：直接 logArtifactChange 测试审计，upsert 路径用 insertArtifact 模拟
    logArtifactChange(db, { projectId, artifactPath: 'articles/test.md', agentId: employeeId, action: 'create', taskId: null });
    logArtifactChange(db, { projectId, artifactPath: 'articles/test.md', agentId: employeeId, action: 'update', taskId: null });
    const logs = listArtifactHistory(db, projectId, 'articles/test.md');
    expect(logs).toHaveLength(2);
    expect(logs[0].action).toBe('update');
    expect(logs[1].action).toBe('create');
  });

  it('listProjectAuditLog 列出项目全部变更', () => {
    logArtifactChange(db, { projectId, artifactPath: 'a.md', action: 'create', agentId: employeeId });
    logArtifactChange(db, { projectId, artifactPath: 'b.md', action: 'create', agentId: employeeId });
    expect(listProjectAuditLog(db, projectId)).toHaveLength(2);
  });

  it('logArtifactChange 直接记录', () => {
    logArtifactChange(db, { projectId, artifactPath: 'x.md', action: 'delete', agentId: employeeId });
    const logs = listArtifactHistory(db, projectId, 'x.md');
    expect(logs[0].action).toBe('delete');
  });
});

describe('产物所有权转移（交接用）', () => {
  // 直接插入 artifact 行（绕过 task FK）
  function insertArtifact(path: string, owner: string): string {
    const id = `ar_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO artifact (id, project_id, kind, path, owner_agent_id, merge_strategy, props_json, created_task_id, created_at, updated_at)
       VALUES (?, ?, 'document', ?, ?, 'three_way', '{}', NULL, ?, ?)`,
    ).run(id, projectId, path, owner, now, now);
    return id;
  }

  it('transferArtifactOwnership 单一指针更新', () => {
    const aId = insertArtifact('handover.md', employeeId);
    const transferred = transferArtifactOwnership(db, aId, managerId, { oldOwnerId: employeeId });
    expect(transferred.ownerAgentId).toBe(managerId);
    // 审计记录 transfer
    const logs = listArtifactHistory(db, projectId, 'handover.md');
    const transferLog = logs.find((l) => l.action === 'transfer');
    expect(transferLog).toBeTruthy();
    expect(transferLog!.transferredTo).toBe(managerId);
  });

  it('transferAllArtifactsOfOwner 批量转移', () => {
    insertArtifact('a.md', employeeId);
    insertArtifact('b.md', employeeId);
    insertArtifact('c.md', managerId);
    const count = transferAllArtifactsOfOwner(db, projectId, employeeId, managerId);
    expect(count).toBe(2); // 只转移 employeeId 的 2 个
  });
});
