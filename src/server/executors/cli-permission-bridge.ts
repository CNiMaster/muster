import { isAbsolute, resolve } from 'node:path';
import { detectSymlinkTraversalDeletion } from './symlink-traversal';

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
    return{action:classifyCommand(command,{cwd:request.cwd}),command,path:request.cwd};
  }
  const rawPath=request.input.file_path??request.input.path??request.input.notebook_path;
  const path=typeof rawPath==='string'?(isAbsolute(rawPath)?rawPath:resolve(request.cwd,rawPath)):request.cwd;
  if(tool.includes('write')||tool.includes('edit')||tool.includes('patch')||tool.includes('notebook'))return{action:'write-file',path};
  if(tool.includes('read')||tool.includes('glob')||tool.includes('grep'))return{action:'read-file',path};
  if(tool.includes('web')||tool.includes('fetch'))return{action:'network-access',path:request.cwd};
  return{action:'tool-call',path:request.cwd,command:request.toolName};
}

/**
 * 命令风险分级（静态）。穿链删除检测（cwd 有共享环境软链时的 rm/find/realpath/cd 解析型
 * 删除）归入 delete-outside-project——与 git-push 等同列 HIGH_RISK_ACTIONS，
 * 三档守卫（审批队列/no-approval AI 门/基线拒绝）自动接管，见 symlink-traversal.ts。
 */
export function classifyCommand(command:string,opts?:{cwd?:string}):string{
  const normalized=command.trim().toLowerCase();
  if(/(^|[\s'";&|])git\s+push(?:\s|$)/.test(normalized))return'git-push';
  if(/(^|[;&|]\s*)(npm\s+(publish|install\s+-g)|brew\s+install|sudo\s+.*install|curl\b.*\|\s*(sh|bash))/.test(normalized))return'system-install';
  if(/(^|[;&|]\s*)(vercel|netlify|flyctl|kubectl)\b.*\b(deploy|apply|push)\b/.test(normalized))return'deploy';
  if(/\b(keychain|credentials?|auth\.json)|(?:^|[\s\/])(?:\.ssh\/|\.aws\/|\.config\/gcloud)/.test(normalized))return'credential-access';
  if(detectSymlinkTraversalDeletion(command,{cwd:opts?.cwd}))return'delete-outside-project';
  return'run-command';
}
