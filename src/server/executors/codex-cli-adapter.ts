import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ExecutionAdapter, ExecutionContext, ExecutionEvents, ExecutionRunResult } from '../task-engine/executor';
import { AGENT_RESULT_JSON_SCHEMA, agentRunResultSchema } from './result-schema';
import { AppError, ErrorCode } from '../../shared/errors';
import { evaluateCliToolRequest, type CliApprovalDecision } from './cli-permission-bridge';
import { tryParseJSON } from '../../shared/utils';
import { resolveCliEnvironment } from './cli-environment';
import { guardedSpawn, sanitizeChildEnv } from './spawn-shell';

export interface CodexApprovalRequest {kind:'command'|'file-change';command?:string;cwd:string;path?:string}
export interface CodexAppServerRunInput {cwd:string;prompt:string;model?:string;existingThreadId?:string;outputSchema:Record<string,unknown>;approvalPolicy:'untrusted'|'never';sandbox:'read-only'|'workspace-write';signal?:AbortSignal;timeoutMs:number;onApproval:(request:CodexApprovalRequest)=>Promise<CliApprovalDecision>;onOutput?:(chunk:string)=>void}
export interface CodexAppServer {run(input:CodexAppServerRunInput):Promise<{threadId:string;text:string;approvalDeniedMessage?:string}>;compact?(threadId:string,cwd:string):Promise<void>;close():void|Promise<void>}
type AppServerFactory=(binary:string,options:{cwd:string;env:NodeJS.ProcessEnv})=>Promise<CodexAppServer>;

export class CodexCliAdapter implements ExecutionAdapter {
  constructor(private options:{appServerFactory?:AppServerFactory}={}){}
  async run(ctx:ExecutionContext,events?:ExecutionEvents):Promise<ExecutionRunResult>{
    const binary=ctx.agentExecutor?.binaryPath??'codex';
    const server=await(this.options.appServerFactory??createStdioAppServer)(binary,{cwd:ctx.workingDir,env:await resolveCliEnvironment()});
    try{
      const prompt=[ctx.systemPrompt,'# 当前 Task 工作包',JSON.stringify(ctx.inputPacket,null,2),'只返回符合指定 JSON Schema 的最终结果。'].join('\n\n');
      const response=await server.run({
        cwd:ctx.workingDir,prompt,model:ctx.agentExecutor?.model,existingThreadId:ctx.sessionIdHint,
        outputSchema:AGENT_RESULT_JSON_SCHEMA as Record<string,unknown>,
        approvalPolicy:ctx.permissionPolicy?.approvalStrategy==='deny'?'never':'untrusted',
        sandbox:ctx.permissionPolicy?.approvalStrategy==='deny'?'read-only':'workspace-write',
        signal:ctx.signal,timeoutMs:ctx.agentExecutor?.timeoutMs??600_000,onOutput:events?.onOutput,
        onApproval:request=>evaluateCliToolRequest(ctx.permissionGuard,{toolName:request.kind==='command'?'Bash':'Write',input:request.kind==='command'?{command:request.command??''}:{file_path:request.path??request.cwd},cwd:request.cwd}),
      });
      const parsed=agentRunResultSchema.safeParse(tryParseJSON(response.text));
      if(!parsed.success&&response.approvalDeniedMessage)return{outcome:'blocked',summary:response.approvalDeniedMessage,outboundTasks:[],artifacts:[],_sessionIdHint:response.threadId};
      if(!parsed.success)throw new AppError(ErrorCode.VALIDATION,'Codex CLI 未返回有效的 AgentRunResult');
      return{...parsed.data,_sessionIdHint:response.threadId};
    }finally{await server.close();}
  }
  async compactSession(ctx:ExecutionContext):Promise<void>{if(!ctx.sessionIdHint)throw new AppError(ErrorCode.VALIDATION,'Codex 会话不存在，无法压缩');const binary=ctx.agentExecutor?.binaryPath??'codex';const server=await(this.options.appServerFactory??createStdioAppServer)(binary,{cwd:ctx.workingDir,env:await resolveCliEnvironment()});try{if(!server.compact)throw new AppError(ErrorCode.VALIDATION,'当前 Codex app-server 不支持压缩');await server.compact(ctx.sessionIdHint,ctx.workingDir);}finally{await server.close();}}
}

async function createStdioAppServer(binary:string,options:{cwd:string;env:NodeJS.ProcessEnv}):Promise<CodexAppServer>{return new StdioCodexAppServer(binary,options);}

class StdioCodexAppServer implements CodexAppServer{
  private child:ChildProcessWithoutNullStreams;
  private killGroup:(sig:NodeJS.Signals)=>void;
  private nextId=1;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  private turnWaiter?:{resolve:(value:{threadId:string;text:string;approvalDeniedMessage?:string})=>void;reject:(error:Error)=>void;threadId:string;text:string;approvalDeniedMessage?:string;onApproval:CodexAppServerRunInput['onApproval'];onOutput?:CodexAppServerRunInput['onOutput'];timer:NodeJS.Timeout};
  private initialized:Promise<void>;
  constructor(binary:string,options:{cwd:string;env:NodeJS.ProcessEnv}){
    // H9a 统一执行壳：进程组+env 清洗+seatbelt 围栏（worktree 外写被 OS 拒；codex 自带沙箱管它的工具，外层管它的越界）
    const guarded=guardedSpawn(binary,['app-server','--listen','stdio://'],{cwd:options.cwd,writableRoots:[options.cwd],commonPaths:true,env:sanitizeChildEnv(options.env),id:'codex'});
    this.child=guarded.child;
    this.killGroup=guarded.killGroup;
    createInterface({input:this.child.stdout}).on('line',line=>this.handleLine(line));
    let stderr='';this.child.stderr.on('data',chunk=>{stderr+=String(chunk);});
    this.child.on('exit',code=>{const error=new AppError(ErrorCode.INTERNAL,`Codex app-server 已退出 (${code??'signal'}): ${stderr.slice(-2000)}`);for(const item of this.pending.values())item.reject(error);this.turnWaiter?.reject(error);});
    this.initialized=this.request('initialize',{clientInfo:{name:'muster',title:'Muster',version:'3.0.0'},capabilities:null}).then(()=>{this.notify('initialized');});
  }
  async run(input:CodexAppServerRunInput):Promise<{threadId:string;text:string;approvalDeniedMessage?:string}>{
    await this.initialized;
    const threadResponse=await this.request(input.existingThreadId?'thread/resume':'thread/start',input.existingThreadId?{threadId:input.existingThreadId,cwd:input.cwd,model:input.model??null,approvalPolicy:input.approvalPolicy,approvalsReviewer:'user',sandbox:input.sandbox}:{cwd:input.cwd,model:input.model??null,approvalPolicy:input.approvalPolicy,approvalsReviewer:'user',sandbox:input.sandbox,ephemeral:false});
    const threadId=String(threadResponse.thread.id);
    // AgentRunResult contains an extensible payload object. Codex app-server's
    // strict Responses schema rejects arbitrary object properties, so Muster
    // validates the final JSON with agentRunResultSchema instead.
    await this.request('turn/start',{threadId,input:[{type:'text',text:input.prompt,text_elements:[]}],cwd:input.cwd,approvalPolicy:input.approvalPolicy,model:input.model??null});
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{reject(new AppError(ErrorCode.INTERNAL,`Codex CLI 执行超时 (${input.timeoutMs}ms)`));this.killGroup('SIGTERM');},input.timeoutMs);
      this.turnWaiter={resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);},threadId,text:'',onApproval:input.onApproval,onOutput:input.onOutput,timer};
      input.signal?.addEventListener('abort',()=>{this.killGroup('SIGTERM');reject(new AppError(ErrorCode.INTERNAL,'Codex CLI 执行已取消'));},{once:true});
    });
  }
  close():void{this.killGroup('SIGTERM');}
  async compact(threadId:string,cwd:string):Promise<void>{await this.initialized;await this.request('thread/resume',{threadId,cwd});await this.request('thread/compact/start',{threadId});}
  private request(method:string,params:unknown):Promise<any>{const id=this.nextId++;this.write({method,id,params});return new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}));}
  private notify(method:string,params?:unknown):void{this.write(params===undefined?{method}:{method,params});}
  private write(message:unknown):void{this.child.stdin.write(`${JSON.stringify(message)}\n`);}
  private handleLine(line:string):void{
    let message:any;try{message=JSON.parse(line);}catch{return;}
    if(message.id!==undefined&&!message.method){const pending=this.pending.get(Number(message.id));if(!pending)return;this.pending.delete(Number(message.id));message.error?pending.reject(new Error(message.error.message??'Codex RPC error')):pending.resolve(message.result);return;}
    if(message.id!==undefined&&message.method){void this.handleServerRequest(message);return;}
    const waiter=this.turnWaiter;if(!waiter)return;
    if(message.method==='item/agentMessage/delta'){const delta=String(message.params?.delta??'');if(delta){waiter.text+=delta;waiter.onOutput?.(delta);}}
    if(message.method==='item/completed'&&message.params?.item?.type==='agentMessage')waiter.text=String(message.params.item.text??waiter.text);
    if(message.method==='turn/completed'){
      if(message.params?.turn?.status==='failed'){
        const detail=String(message.params?.turn?.error?.message??'未知错误');this.turnWaiter=undefined;waiter.reject(new AppError(ErrorCode.INTERNAL,`Codex CLI 执行失败: ${detail}`));return;
      }
      const items=message.params?.turn?.items??[];const text=[...items].reverse().find((item:any)=>item.type==='agentMessage')?.text??'';
      this.turnWaiter=undefined;waiter.resolve({threadId:waiter.threadId,text:text||waiter.text,approvalDeniedMessage:waiter.approvalDeniedMessage});
    }
  }
  private async handleServerRequest(message:any):Promise<void>{
    const waiter=this.turnWaiter;
    if(!waiter){this.write({id:message.id,error:{code:-32000,message:'No active Muster Task'}});return;}
    let request:CodexApprovalRequest|undefined;
    if(message.method==='item/commandExecution/requestApproval'||message.method==='execCommandApproval')request={kind:'command',command:Array.isArray(message.params?.command)?message.params.command.join(' '):String(message.params?.command??''),cwd:message.params?.cwd??process.cwd()};
    if(message.method==='item/fileChange/requestApproval'||message.method==='applyPatchApproval')request={kind:'file-change',cwd:message.params?.cwd??process.cwd(),path:message.params?.grantRoot??message.params?.cwd};
    if(!request){this.write({id:message.id,error:{code:-32601,message:`Unsupported server request: ${message.method}`}});return;}
    const decision=await waiter.onApproval(request);
    if(!decision.approved)waiter.approvalDeniedMessage=decision.message??'Muster 权限策略拒绝了此操作';
    this.write({id:message.id,result:{decision:decision.approved?'accept':'decline'}});
  }
}
