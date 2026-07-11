import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExecutionAdapter, ExecutionContext, ExecutionEvents, ExecutionRunResult } from '../task-engine/executor';
import { AGENT_RESULT_JSON_SCHEMA, agentRunResultSchema } from './result-schema';
import { AppError, ErrorCode } from '../../shared/errors';

const execFileAsync=promisify(execFile);
type Runner=(binary:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv;signal?:AbortSignal;timeout:number})=>Promise<{exitCode:number;stdout:string;stderr:string}>;
const defaultRunner:Runner=async(binary,args,options)=>{try{const result=await execFileAsync(binary,args,{cwd:options.cwd,env:options.env,signal:options.signal,timeout:options.timeout,maxBuffer:16*1024*1024});return{exitCode:0,stdout:result.stdout,stderr:result.stderr};}catch(error:any){return{exitCode:typeof error.code==='number'?error.code:1,stdout:error.stdout??'',stderr:error.stderr??error.message};}};

export class CodexCliAdapter implements ExecutionAdapter {
  constructor(private options:{runner?:Runner}={}){}
  async run(ctx:ExecutionContext,events?:ExecutionEvents):Promise<ExecutionRunResult>{
    const binary=ctx.agentExecutor?.binaryPath??'codex';
    const temp=ctx.runTempDir??join(ctx.workingDir,'.muster-tmp');mkdirSync(temp,{recursive:true});
    const key=randomUUID();const schemaPath=join(temp,`${key}.schema.json`);const outputPath=join(temp,`${key}.result.json`);
    writeFileSync(schemaPath,JSON.stringify(AGENT_RESULT_JSON_SCHEMA));
    const prompt=[ctx.systemPrompt,'# 当前 Task 工作包',JSON.stringify(ctx.inputPacket,null,2),'只返回符合指定 JSON Schema 的最终结果。'].join('\n\n');
    const common=['--json','--output-schema',schemaPath,'-o',outputPath];
    const policy=ctx.permissionPolicy;
    const approval=policy?.approvalStrategy==='no-approval'?'never':'untrusted';
    if(ctx.agentExecutor?.model)common.push('-m',ctx.agentExecutor.model);
    const sandbox=policy?.approvalStrategy==='deny'?'read-only':'workspace-write';
    const initialPolicy=['-a',approval,'-s',sandbox,'-C',ctx.workingDir];
    for(const root of policy?.allowedRoots??[]){if(root!==ctx.workingDir)initialPolicy.push('--add-dir',root);}
    const args=ctx.sessionIdHint?['exec','resume',ctx.sessionIdHint,...common,'-c',`approval_policy="${approval}"`,'-c',`sandbox_mode="${sandbox}"`,prompt]:['exec',...common,...initialPolicy,prompt];
    prepareCodexHome(ctx.runConfigDir);
    const result=await (this.options.runner??defaultRunner)(binary,args,{cwd:ctx.workingDir,env:{...process.env,CODEX_HOME:ctx.runConfigDir??process.env.CODEX_HOME},signal:ctx.signal,timeout:ctx.agentExecutor?.timeoutMs??600_000});
    for(const line of result.stdout.split(/\r?\n/).filter(Boolean))events?.onOutput?.(line);
    if(result.exitCode!==0)throw new AppError(ErrorCode.INTERNAL,`Codex CLI 执行失败: ${result.stderr.slice(0,2000)}`);
    let parsed:unknown;try{parsed=JSON.parse(readFileSync(outputPath,'utf8'));}catch{throw new AppError(ErrorCode.VALIDATION,'Codex CLI 未返回有效的结构化结果');}
    const validated=agentRunResultSchema.parse(parsed);const sessionId=findSessionId(result.stdout);
    return{...validated,_sessionIdHint:sessionId??ctx.sessionIdHint};
  }
}
function findSessionId(stdout:string):string|null{for(const line of stdout.split(/\r?\n/)){try{const event=JSON.parse(line);if(event.thread_id)return event.thread_id;if(event.session_id)return event.session_id;}catch{/* non-json diagnostic */}}return null;}
function prepareCodexHome(target:string|undefined):void{if(!target)return;mkdirSync(target,{recursive:true});const source=join(process.env.HOME??'', '.codex','auth.json');const link=join(target,'auth.json');if(source&&existsSync(source)&&!existsSync(link))symlinkSync(source,link);}
