import { restoreWorkbench } from '../../src/server/domain/workbench';
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
;
import { createAgent } from '../../src/server/domain/agent';
import { executeFileTool } from '../../src/server/executors/tools/file-tools';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProject } from '../../src/server/domain/project';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { createTask, claimNextTask, markRunning } from '../../src/server/domain/task';

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

  it('company-scoped rule retired (D4-3→批次D)：rule.company_id 列已物理删除（规则全平台化）', () => {
    const { db, close } = makeTestDb();
    try {
      const policy = createPermissionPolicy(db, { name: '测试', approvalStrategy: 'ask-by-rule', scope: 'task' });
      savePermissionRule(db, policy.id, { effect: 'deny', action: 'run-command', commandPattern: '^rm\\b' });
      // 批次 D 迁移 E 已 DROP permission_rule.company_id——历史残留形状不复存在
      const cols = (db.prepare('PRAGMA table_info(permission_rule)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).not.toContain('company_id');
      const res = evaluatePermission(db, policy.id, {
        action: 'run-command', command: 'rm file', path: '/p', taskRoot: '/p', projectRoot: '/p', workspaceRoot: '/',
      });
      expect(res.decision).toBe('deny'); // 公司条件退役，规则命中
    } finally { close(); }
  });

  it('bindEmployeePermissionPolicy 锁=执行期（2026-08-23 上下班退役：空闲可改，任务执行中锁）', () => {
    const { db, close } = makeTestDb();
    try {
      const company = restoreWorkbench(db, { id: 'wb_fix_1', name: '默认工作台', kind: 'general' });
      const lead = createAgent(db, { companyId: company.id, name: '负责人', role: 'lead' });
      const policy = createPermissionPolicy(db, { name: 'P', approvalStrategy: 'ask-always', scope: 'task' });
      const project = createProject(db, { companyId: company.id, name: 'p', rootDir: '/tmp/pp-lock' });
      const thread = ensurePrimaryThread(db, project.id, lead.id);
      const task = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '执行中' });

      // 默认 online 但空闲 → 可改
      expect(() => bindEmployeePermissionPolicy(db, lead.id, policy.id)).not.toThrow();

      // 任务执行中 → 锁
      claimNextTask(db, thread.id, lead.id);
      markRunning(db, task.id);
      expect(() => bindEmployeePermissionPolicy(db, lead.id, policy.id)).toThrowError(/执行中/);
    } finally { close(); }
  });
});
