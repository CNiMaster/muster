import { describe,expect,it,vi } from 'vitest';
import { GeminiCliAdapter } from '../../src/server/executors/gemini-cli-adapter';
import type { ExecutionContext } from '../../src/server/task-engine/executor';

describe('Gemini CLI adapter',()=>{
  it('uses headless streaming JSON, sandbox, worktree and explicit session',async()=>{
    const payload=JSON.stringify({outcome:'completed',summary:'gemini done',outboundTasks:[],artifacts:[]});
    const runner=vi.fn(async()=>({exitCode:0,stdout:[JSON.stringify({type:'init',session_id:'g-session'}),JSON.stringify({type:'message',role:'assistant',content:payload}),JSON.stringify({type:'result',stats:{input_tokens:12,output_tokens:5}})].join('\n'),stderr:''}));
    const ctx={task:{id:'t'} as any,systemPrompt:'identity',workingDir:'/project/task',inputPacket:{goal:'work'},sessionIdHint:'existing',agentExecutor:{binaryPath:'/managed/gemini',model:'gemini-2.5-pro'}} satisfies ExecutionContext;
    const result=await new GeminiCliAdapter({runner}).run(ctx);
    const [binary,args,options]=runner.mock.calls[0]!;
    expect(binary).toBe('/managed/gemini');
    expect(args).toContain('--output-format');expect(args).toContain('stream-json');expect(args).toContain('--sandbox');
    expect(args).toContain('--resume');expect(args).toContain('existing');
    expect(options.cwd).toBe('/project/task');
    expect(result.summary).toBe('gemini done');expect(result._sessionIdHint).toBe('g-session');expect(result._usage?.inputTokens).toBe(12);
  });
});
