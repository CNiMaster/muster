import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateCliToolRequest, type PermissionGuard } from './cli-permission-bridge';

export interface ClaudePermissionBridge {settingsPath:string;helperPath:string;hookUrl:string;close():Promise<void>}

export async function startClaudePermissionBridge(configDir:string,cwd:string,guard:PermissionGuard|undefined):Promise<ClaudePermissionBridge>{
  mkdirSync(configDir,{recursive:true});
  const token=randomUUID();
  const server=createServer((req,res)=>{
    if(req.method!=='POST'||req.url!==`/${token}`){res.writeHead(404).end();return;}
    let body='';
    req.setEncoding('utf8');
    req.on('data',chunk=>{body+=chunk;if(body.length>1024*1024)req.destroy();});
    req.on('end',()=>{
      let payload:any;try{payload=JSON.parse(body);}catch{respond(res,deny('Muster 权限桥收到无效请求'));return;}
      const decision=evaluateCliToolRequest(guard,{toolName:String(payload.tool_name??''),input:isRecord(payload.tool_input)?payload.tool_input:{},cwd});
      respond(res,decision.approved?allow():deny(decision.message??'Muster 权限策略拒绝了此操作'));
    });
  });
  await listen(server);
  const address=server.address();if(!address||typeof address==='string')throw new Error('无法启动 Claude 权限桥');
  const hookUrl=`http://127.0.0.1:${address.port}/${token}`;
  const helperPath=join(configDir,`claude-permission-${token}.mjs`);
  writeFileSync(helperPath,CLAUDE_HOOK_HELPER);
  const settingsPath=join(configDir,`claude-permission-${token}.json`);
  writeFileSync(settingsPath,JSON.stringify({hooks:{PreToolUse:[{matcher:'*',hooks:[{type:'command',command:process.execPath,args:[helperPath,hookUrl],timeout:30,statusMessage:'正在请求 Muster 权限策略'}]}]}}));
  return{settingsPath,helperPath,hookUrl,close:()=>close(server)};
}

const CLAUDE_HOOK_HELPER=`let body='';for await(const chunk of process.stdin)body+=chunk;const deny=reason=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}});try{const response=await fetch(process.argv[2],{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(2000)});if(!response.ok)throw new Error('HTTP '+response.status);process.stdout.write(await response.text());}catch(error){process.stdout.write(JSON.stringify(deny('Muster 权限桥不可用，操作已安全拒绝')));}`;

function allow(){return{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',permissionDecisionReason:'Muster 权限策略允许'}};}
function deny(reason:string){return{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}};}
function respond(res:any,value:unknown){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function listen(server:Server):Promise<void>{return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});}
function close(server:Server):Promise<void>{return new Promise(resolve=>server.close(()=>resolve()));}
