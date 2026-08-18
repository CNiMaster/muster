import { describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import {
  createPermissionPolicy,
  evaluatePermission,
  listApprovalQueue,
  recordApprovalDecision,
  requestApproval,
  savePermissionRule,
  bindEmployeePermissionPolicy,
} from '../../src/server/domain/permission';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { executeFileTool } from '../../src/server/executors/tools/file-tools';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('permission policy = approval strategy × allowed scope', () => {
  it('keeps Turbo bounded by scope and never auto-allows high-risk actions', () => {
    const { db, close } = makeTestDb();
    try {
      const policy = createPermissionPolicy(db, { name: '项目 Turbo', approvalStrategy: 'no-approval', scope: 'project' });
      expect(evaluatePermission(db, policy.id, { action: 'write-file', path: '/workspace/project/src/a.ts', taskRoot: '/workspace/project/.worktree', projectRoot: '/workspace/project', workspaceRoot: '/workspace' }).decision).toBe('allow');
      expect(evaluatePermission(db, policy.id, { action: 'write-file', path: '/workspace/other/a.ts', taskRoot: '/workspace/project/.worktree', projectRoot: '/workspace/project', workspaceRoot: '/workspace' }).decision).toBe('approval-required');
      expect(evaluatePermission(db, policy.id, { action: 'git-push', path: '/workspace/project', taskRoot: '/workspace/project/.worktree', projectRoot: '/workspace/project', workspaceRoot: '/workspace' }).decision).toBe('approval-required');
    } finally { close(); }
  });

  it('supports once, command, directory, and custom durable decisions', () => {
    const { db, close } = makeTestDb();
    try {
      const policy = createPermissionPolicy(db, { name: '询问', approvalStrategy: 'ask-always', scope: 'task' });
      const request = requestApproval(db, { policyId: policy.id, employeeId: 'e1', taskId: 't1', action: 'run-command', command: 'npm test', path: '/p' });
      recordApprovalDecision(db, request.id, { decision: 'allow-command' });
      expect(evaluatePermission(db, policy.id, { action: 'run-command', command: 'npm test', path: '/p', taskRoot: '/p', projectRoot: '/p', workspaceRoot: '/' }).decision).toBe('allow');
      savePermissionRule(db, policy.id, { effect: 'deny', action: 'run-command', commandPattern: '^rm\\b' });
      expect(evaluatePermission(db, policy.id, { action: 'run-command', command: 'rm file', path: '/p', taskRoot: '/p', projectRoot: '/p', workspaceRoot: '/' }).decision).toBe('deny');
    } finally { close(); }
  });

  it('prevents an API model tool from writing before approval', async () => {
    const root=mkdtempSync(join(tmpdir(),'muster-permission-'));
    try {
      const result=await executeFileTool({id:'call',name:'write_file',args:{path:'secret.txt',content:'no'}},root,[],undefined,()=>({allowed:false,message:'等待用户审批'}));
      expect(result.content).toContain('需要用户审批');
      expect(existsSync(join(root,'secret.txt'))).toBe(false);
    } finally {rmSync(root,{recursive:true,force:true});}
  });

  it('allow-once permits only the same Task operation for a limited time', () => {
    const {db,close}=makeTestDb();
    try {
      const policy=createPermissionPolicy(db,{name:'询问',approvalStrategy:'ask-always',scope:'task'});
      const approval=requestApproval(db,{policyId:policy.id,employeeId:'e',taskId:'task-a',action:'write-file',path:'/p/a.txt'});
      recordApprovalDecision(db,approval.id,{decision:'allow-once'});
      const base={action:'write-file',path:'/p/a.txt',taskRoot:'/p',projectRoot:'/p',workspaceRoot:'/'};
      expect(evaluatePermission(db,policy.id,{...base,taskId:'task-a'}).decision).toBe('allow');
      expect(evaluatePermission(db,policy.id,{...base,taskId:'task-b'}).decision).toBe('approval-required');
    } finally {close();}
  });

  it('explains whether approval can resume online or must be requeued', () => {
    const {db,close}=makeTestDb();
    try {
      const policy=createPermissionPolicy(db,{name:'询问',approvalStrategy:'ask-always',scope:'task'});
      const approval=requestApproval(db,{policyId:policy.id,employeeId:'e',taskId:'t',action:'run-command'});
      db.prepare('UPDATE permission_approval SET expires_at=? WHERE id=?').run(new Date(Date.now()+300_000).toISOString(),approval.id);
      expect(listApprovalQueue(db,(id)=>id===approval.id)[0]).toMatchObject({online:true,resumeMode:'direct'});
      expect(String(listApprovalQueue(db,()=>false)[0]?.statusText)).toContain('重新入队');
    } finally {close();}
  });

  it('company-scoped rule retired (D4-3)：rule.company_id 不再限制匹配（规则全平台化）', () => {
    const { db, close } = makeTestDb();
    try {
      const policy = createPermissionPolicy(db, { name: '测试', approvalStrategy: 'ask-by-rule', scope: 'task' });
      savePermissionRule(db, policy.id, { effect: 'deny', action: 'run-command', commandPattern: '^rm\\b' });
      // 历史数据形状：规则残留 company_id（与请求不同）
      db.prepare('UPDATE permission_rule SET company_id=? WHERE policy_id=?').run('co_other', policy.id);
      const res = evaluatePermission(db, policy.id, {
        action: 'run-command', command: 'rm file', path: '/p', taskRoot: '/p', projectRoot: '/p', workspaceRoot: '/',
        companyId: 'co_default',
      });
      expect(res.decision).toBe('deny'); // 公司条件退役，规则命中
    } finally { close(); }
  });

  it('bindEmployeePermissionPolicy 锁仍按工作台下班态（D4-3）', () => {
    const { db, close } = makeTestDb();
    try {
      const company = createCompany(db, { name: '默认工作台', kind: 'general' });
      const lead = createAgent(db, { companyId: company.id, name: '负责人', role: 'lead' });
      const policy = createPermissionPolicy(db, { name: 'P', approvalStrategy: 'ask-always', scope: 'task' });

      db.prepare("UPDATE company SET state='off' WHERE id=?").run(company.id);
      expect(() => bindEmployeePermissionPolicy(db, lead.id, policy.id)).not.toThrow();

      db.prepare("UPDATE company SET state='online' WHERE id=?").run(company.id);
      expect(() => bindEmployeePermissionPolicy(db, lead.id, policy.id)).toThrowError(/下班/);
    } finally { close(); }
  });
});
