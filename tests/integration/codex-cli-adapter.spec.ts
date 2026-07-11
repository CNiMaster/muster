import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexCliAdapter, type CodexAppServer } from '../../src/server/executors/codex-cli-adapter';
import type { ExecutionContext } from '../../src/server/task-engine/executor';

describe('Codex CLI app-server adapter', () => {
  it('runs a turn through app-server and captures the employee thread', async () => {
    const root=mkdtempSync(join(tmpdir(),'muster-codex-adapter-'));
    try {
      const server:CodexAppServer={
        run:vi.fn(async input=>{
          expect(input.cwd).toBe(root);
          expect(input.existingThreadId).toBeUndefined();
          expect(input.outputSchema.required).toContain('outcome');
          return {threadId:'thread-123',text:JSON.stringify({outcome:'completed',summary:'done',outboundTasks:[],artifacts:[]})};
        }),
        close:vi.fn(),
      };
      const factory=vi.fn(async()=>server);
      const result=await new CodexCliAdapter({appServerFactory:factory}).run(context(root));
      expect(factory).toHaveBeenCalledWith('/managed/codex',expect.objectContaining({cwd:root}));
      expect(result.summary).toBe('done');
      expect(result._sessionIdHint).toBe('thread-123');
      expect(server.close).toHaveBeenCalled();
    } finally {rmSync(root,{recursive:true,force:true});}
  });

  it('routes command approval requests through the Muster permission guard', async () => {
    const root=mkdtempSync(join(tmpdir(),'muster-codex-adapter-'));
    try {
      const guard=vi.fn(()=>({allowed:false,message:'审批请求 approval_1 已进入审批中心'}));
      const server:CodexAppServer={
        run:vi.fn(async input=>{
          const decision=input.onApproval({kind:'command',command:'git push origin main',cwd:root});
          expect(decision).toEqual({approved:false,message:'审批请求 approval_1 已进入审批中心'});
          return {threadId:'employee-session',text:JSON.stringify({outcome:'blocked',summary:decision.message,outboundTasks:[],artifacts:[]})};
        }),
        close:vi.fn(),
      };
      const result=await new CodexCliAdapter({appServerFactory:async()=>server}).run({...context(root),permissionGuard:guard,sessionIdHint:'employee-session'});
      expect(guard).toHaveBeenCalledWith({action:'git-push',command:'git push origin main',path:root});
      expect(result.outcome).toBe('blocked');
    } finally {rmSync(root,{recursive:true,force:true});}
  });

  it('returns a deterministic blocked result when Codex stops after a denied approval',async()=>{
    const root=mkdtempSync(join(tmpdir(),'muster-codex-adapter-'));
    try{
      const server:CodexAppServer={run:vi.fn(async()=>({threadId:'thread-denied',text:'',approvalDeniedMessage:'审批请求 approval_3 已进入审批中心'})),close:vi.fn()};
      const result=await new CodexCliAdapter({appServerFactory:async()=>server}).run({...context(root),permissionGuard:()=>({allowed:false})});
      expect(result).toMatchObject({outcome:'blocked',summary:'审批请求 approval_3 已进入审批中心',_sessionIdHint:'thread-denied'});
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});

function context(root:string):ExecutionContext{return{task:{id:'t',projectId:'p'} as any,systemPrompt:'You are employee',workingDir:root,inputPacket:{goal:'work'},agentExecutor:{binaryPath:'/managed/codex',model:'gpt-5'}};}
