import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateCliToolRequest, type PermissionGuard } from './cli-permission-bridge';

export interface AntigravityPermissionBridge { pluginPath:string; hooksPath:string; helperPath:string; close():Promise<void> }

export async function startAntigravityPermissionBridge(workspace:string,guard:PermissionGuard|undefined):Promise<AntigravityPermissionBridge>{
  const token=randomUUID();
  const pluginDir=join(workspace,'.agy','plugins',`muster-${token}`);
  mkdirSync(pluginDir,{recursive:true});
  const server=createServer((req,res)=>{if(req.method!=='POST'||req.url!==`/${token}`){res.writeHead(404).end();return;}let body='';req.setEncoding('utf8');req.on('data',chunk=>{body+=chunk;if(body.length>1024*1024)req.destroy();});req.on('end',async()=>{let payload:any;try{payload=JSON.parse(body);}catch{respond(res,false,'Muster 权限桥收到无效请求');return;}const decision=await evaluateCliToolRequest(guard,{toolName:String(payload.tool_name??payload.toolName??''),input:isRecord(payload.tool_input??payload.toolInput)?(payload.tool_input??payload.toolInput):{},cwd:workspace});respond(res,decision.approved,decision.message);});});
  await listen(server);const address=server.address();if(!address||typeof address==='string')throw new Error('无法启动 Antigravity 权限桥');
  const helperPath=join(pluginDir,'permission-hook.mjs');
  writeFileSync(helperPath,`let body='';for await(const chunk of process.stdin)body+=chunk;try{const response=await fetch(process.argv[2],{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(2000)});if(!response.ok)throw new Error('HTTP '+response.status);process.stdout.write(await response.text());}catch{process.stdout.write(JSON.stringify({decision:'deny',reason:'Muster 权限桥不可用，操作已安全拒绝'}));}`);
  const hookUrl=`http://127.0.0.1:${address.port}/${token}`;
  const hooksPath=join(pluginDir,'hooks.json');
  writeFileSync(hooksPath,JSON.stringify({hooks:{PreToolUse:[{matcher:'*',hooks:[{type:'command',command:process.execPath,args:[helperPath,hookUrl],timeout:30}]}]}}));
  const pluginPath=join(pluginDir,'plugin.json');
  writeFileSync(pluginPath,JSON.stringify({name:'muster-permission-bridge',version:'1.0.0',hooks:'./hooks.json'}));
  return{pluginPath,hooksPath,helperPath,close:async()=>{await closeServer(server);rmSync(pluginDir,{recursive:true,force:true});}};
}
function respond(res:any,approved:boolean,message?:string){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({decision:approved?'allow':'deny',reason:message??(approved?'Muster 权限策略允许':'Muster 权限策略拒绝')}));}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function listen(server:Server):Promise<void>{return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});}
function closeServer(server:Server):Promise<void>{return new Promise(resolve=>server.close(()=>resolve()));}
