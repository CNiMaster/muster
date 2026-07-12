import { describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateCliToolRequest } from '../../src/server/executors/cli-permission-bridge';
import { startClaudePermissionBridge } from '../../src/server/executors/claude-permission-bridge';

describe('CLI permission bridge',()=>{
  it('classifies high-risk commands before invoking the common guard',()=>{
    const guard=vi.fn(()=>({allowed:false,message:'needs approval'}));
    const result=evaluateCliToolRequest(guard,{toolName:'Bash',input:{command:'git push origin main'},cwd:'/workspace/project'});
    expect(guard).toHaveBeenCalledWith({action:'git-push',command:'git push origin main',path:'/workspace/project'});
    expect(result).toEqual({approved:false,message:'needs approval'});
  });

  it('classifies commands wrapped by the CLI shell launcher',()=>{
    const guard=vi.fn(()=>({allowed:false}));
    evaluateCliToolRequest(guard,{toolName:'Bash',input:{command:"/bin/zsh -lc 'git push --dry-run'"},cwd:'/workspace/project'});
    expect(guard).toHaveBeenCalledWith({action:'git-push',command:"/bin/zsh -lc 'git push --dry-run'",path:'/workspace/project'});
  });

  it('maps Claude file edits to the exact path',()=>{
    const guard=vi.fn(()=>({allowed:true}));
    expect(evaluateCliToolRequest(guard,{toolName:'Write',input:{file_path:'/workspace/project/a.ts'},cwd:'/workspace/project'})).toEqual({approved:true,message:undefined});
    expect(guard).toHaveBeenCalledWith({action:'write-file',path:'/workspace/project/a.ts'});
  });

  it('fails closed when no permission guard is available',()=>{
    expect(evaluateCliToolRequest(undefined,{toolName:'Bash',input:{command:'npm test'},cwd:'/workspace/project'})).toEqual({approved:false,message:'执行器没有可用的 Muster 权限策略'});
  });

  it('serves a fail-closed Claude PreToolUse hook from the isolated run directory',async()=>{
    const root=mkdtempSync(join(tmpdir(),'muster-claude-hook-'));
    try{
      const guard=vi.fn(()=>({allowed:false,message:'审批请求 approval_2 已进入审批中心'}));
      const bridge=await startClaudePermissionBridge(root,root,guard);
      const settings=JSON.parse(readFileSync(bridge.settingsPath,'utf8'));
      const hook=settings.hooks.PreToolUse[0].hooks[0];
      expect(hook).toMatchObject({type:'command',command:process.execPath,args:[bridge.helperPath,bridge.hookUrl]});
      const child=execFile(hook.command,hook.args,{encoding:'utf8'});
      let output='';child.stdout!.on('data',chunk=>{output+=String(chunk);});
      child.stdin!.end(JSON.stringify({tool_name:'Bash',tool_input:{command:'git push origin main'}}));
      await new Promise<void>((resolve,reject)=>child.on('close',code=>code===0?resolve():reject(new Error(`hook exit ${code}`))));
      expect(JSON.parse(output)).toEqual({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'审批请求 approval_2 已进入审批中心'}});
      await bridge.close();
      const failClosed=execFileSync(hook.command,hook.args,{input:JSON.stringify({tool_name:'Read',tool_input:{file_path:'a'}}),encoding:'utf8'});
      expect(JSON.parse(failClosed).hookSpecificOutput.permissionDecision).toBe('deny');
    }finally{rmSync(root,{recursive:true,force:true});}
  });

});
