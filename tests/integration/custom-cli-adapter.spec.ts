import {describe,expect,it,vi} from 'vitest';
import {CustomCliAdapter} from '../../src/server/executors/custom-cli-adapter';
import type {ExecutionContext} from '../../src/server/task-engine/executor';
describe('custom CLI adapter',()=>{it('expands only declared argument placeholders and never invokes a shell',async()=>{const runner=vi.fn(async()=>({exitCode:0,stdout:JSON.stringify({outcome:'completed',summary:'custom',outboundTasks:[],artifacts:[]}),stderr:''}));const ctx={task:{id:'task-1'} as any,systemPrompt:'identity',workingDir:'/safe/worktree',inputPacket:{goal:'do'},agentExecutor:{binaryPath:'/usr/local/bin/my-agent',customArgs:['--cwd','{cwd}','--prompt','{prompt}','--json']}} satisfies ExecutionContext;const result=await new CustomCliAdapter({runner}).run(ctx);const[bin,args,options]=runner.mock.calls[0]!;expect(options.shell).toBe(false);expect(result.summary).toBe('custom');
// H9a 统一执行壳：沙箱启用时 argv 前插 sandbox-exec -f profile -- 原二进制；关闭时原样。剥壳后契约不变。
const idx=args.indexOf('--');const realBin=idx>=0?args[idx+1]:bin;const realArgs=idx>=0?args.slice(idx+2):args;
expect(realBin).toBe('/usr/local/bin/my-agent');expect(realArgs[1]).toBe('/safe/worktree');expect(realArgs[3]).toContain('identity');
if(idx>=0){expect(bin).toBe('/usr/bin/sandbox-exec');expect(args[0]).toBe('-f');expect(args[1]).toMatch(/\.sb$/);}});});
