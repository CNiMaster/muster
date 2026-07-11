import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexCliAdapter } from '../../src/server/executors/codex-cli-adapter';
import type { ExecutionContext } from '../../src/server/task-engine/executor';

describe('Codex CLI adapter', () => {
  it('runs managed Codex in the Task worktree with schema and captures session', async () => {
    const root=mkdtempSync(join(tmpdir(),'muster-codex-adapter-'));
    try {
      const runner=vi.fn(async (_bin:string,args:string[])=>{
        const output=args[args.indexOf('-o')+1]!;
        writeFileSync(output,JSON.stringify({outcome:'completed',summary:'done',outboundTasks:[],artifacts:[]}));
        return {exitCode:0,stdout:'{"type":"thread.started","thread_id":"thread-123"}\n',stderr:''};
      });
      const adapter=new CodexCliAdapter({runner});
      const result=await adapter.run(context(root));
      const [bin,args,options]=runner.mock.calls[0]!;
      expect(bin).toBe('/managed/codex');
      expect(args.slice(0,2)).toEqual(['exec','--json']);
      expect(args).toContain('--output-schema');
      expect(args).toContain('workspace-write');
      expect(options.cwd).toBe(root);
      expect(result.summary).toBe('done');
      expect(result._sessionIdHint).toBe('thread-123');
      expect(JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1]!, 'utf8')).required).toContain('outcome');
    } finally {rmSync(root,{recursive:true,force:true});}
  });

  it('resumes the employee thread explicitly instead of using another employee latest session', async () => {
    const root=mkdtempSync(join(tmpdir(),'muster-codex-adapter-'));
    try {
      const runner=vi.fn(async (_bin:string,args:string[])=>{writeFileSync(args[args.indexOf('-o')+1]!,JSON.stringify({outcome:'completed',summary:'continued',outboundTasks:[],artifacts:[]}));return{exitCode:0,stdout:'',stderr:''};});
      await new CodexCliAdapter({runner}).run({...context(root),sessionIdHint:'employee-session'});
      expect(runner.mock.calls[0]![1].slice(0,4)).toEqual(['exec','resume','employee-session','--json']);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
});

function context(root:string):ExecutionContext{return{task:{id:'t',projectId:'p'} as any,systemPrompt:'You are employee',workingDir:root,inputPacket:{goal:'work'},agentExecutor:{binaryPath:'/managed/codex',model:'gpt-5'}};}
