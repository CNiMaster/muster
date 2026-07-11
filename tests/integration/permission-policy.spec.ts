import { describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import {
  createPermissionPolicy,
  evaluatePermission,
  recordApprovalDecision,
  requestApproval,
  savePermissionRule,
} from '../../src/server/domain/permission';
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

  it('prevents an API model tool from writing before approval', () => {
    const root=mkdtempSync(join(tmpdir(),'muster-permission-'));
    try {
      const result=executeFileTool({id:'call',name:'write_file',args:{path:'secret.txt',content:'no'}},root,[],undefined,()=>({allowed:false,message:'等待用户审批'}));
      expect(result.content).toContain('需要用户审批');
      expect(existsSync(join(root,'secret.txt'))).toBe(false);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
});
