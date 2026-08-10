import { isAbsolute, resolve } from 'node:path';

export type PermissionGuard = (request:{action:string;path?:string;command?:string})=>{allowed:boolean;message?:string}|Promise<{allowed:boolean;message?:string}>;
export interface CliToolRequest { toolName:string; input:Record<string,unknown>; cwd:string }
export interface CliApprovalDecision { approved:boolean; message?:string }

export async function evaluateCliToolRequest(guard:PermissionGuard|undefined,request:CliToolRequest):Promise<CliApprovalDecision> {
  if(!guard)return{approved:false,message:'执行器没有可用的 Muster 权限策略'};
  const mapped=mapCliToolRequest(request);
  const decision=await guard(mapped);
  return{approved:decision.allowed,message:decision.message};
}

export function mapCliToolRequest(request:CliToolRequest):{action:string;path?:string;command?:string}{
  const tool=request.toolName.toLowerCase();
  if(tool==='bash'||tool.includes('command')||tool.includes('shell')){
    const command=String(request.input.command??request.input.cmd??'');
    return{action:classifyCommand(command),command,path:request.cwd};
  }
  const rawPath=request.input.file_path??request.input.path??request.input.notebook_path;
  const path=typeof rawPath==='string'?(isAbsolute(rawPath)?rawPath:resolve(request.cwd,rawPath)):request.cwd;
  if(tool.includes('write')||tool.includes('edit')||tool.includes('patch')||tool.includes('notebook'))return{action:'write-file',path};
  if(tool.includes('read')||tool.includes('glob')||tool.includes('grep'))return{action:'read-file',path};
  if(tool.includes('web')||tool.includes('fetch'))return{action:'network-access',path:request.cwd};
  return{action:'tool-call',path:request.cwd,command:request.toolName};
}

export function classifyCommand(command:string):string{
  const normalized=command.trim().toLowerCase();
  if(/(^|[\s'";&|])git\s+push(?:\s|$)/.test(normalized))return'git-push';
  if(/(^|[;&|]\s*)(npm\s+(publish|install\s+-g)|brew\s+install|sudo\s+.*install|curl\b.*\|\s*(sh|bash))/.test(normalized))return'system-install';
  if(/(^|[;&|]\s*)(vercel|netlify|flyctl|kubectl)\b.*\b(deploy|apply|push)\b/.test(normalized))return'deploy';
  if(/\b(keychain|credentials?|auth\.json)|(?:^|[\s\/])(?:\.ssh\/|\.aws\/|\.config\/gcloud)/.test(normalized))return'credential-access';
  return'run-command';
}
