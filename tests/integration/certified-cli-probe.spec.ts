import{describe,expect,it,vi}from'vitest';
import{makeTestDb}from'./setup';
import{createExecutorProfile}from'../../src/server/domain/executor-profile';
import{getExecutorManifest}from'../../src/server/executors/manifests';
import{runConnectionProbe,startConnectionProbe}from'../../src/server/domain/connection-probe';

describe('certified CLI manifests and real probes',()=>{
  it('certifies agy while keeping Gemini CLI legacy',()=>{
    const agy=getExecutorManifest('antigravity-cli');
    expect(agy).toMatchObject({displayName:'Antigravity CLI',certification:'certified',approvalBridge:'hook',detection:{command:'agy'}});
    expect(getExecutorManifest('gemini-cli')).toMatchObject({legacy:true,certification:'experimental'});
  });

  it('runs a real non-mutating probe and caches success for 24 hours',async()=>{
    const{db,close}=makeTestDb();try{
      const profile=createExecutorProfile(db,{name:'Agy',manifestId:'antigravity-cli',config:{binaryPath:'/usr/local/bin/agy',provider:'antigravity-cli'}});
      const runtime={run:vi.fn(async()=>({exitCode:0,stdout:'MUSTER_CONNECTION_OK',stderr:'',durationMs:12,filesAfter:[]}))};
      const first=await runConnectionProbe(db,{profileId:profile.id,force:false,runtime,now:new Date('2026-07-12T00:00:00Z')});
      expect(first).toMatchObject({status:'connected',classification:null});
      const cached=await runConnectionProbe(db,{profileId:profile.id,force:false,runtime,now:new Date('2026-07-12T12:00:00Z')});
      expect(cached.id).toBe(first.id);expect(runtime.run).toHaveBeenCalledTimes(1);
      await runConnectionProbe(db,{profileId:profile.id,force:true,runtime,now:new Date('2026-07-12T12:00:01Z')});
      expect(runtime.run).toHaveBeenCalledTimes(2);
    }finally{close();}
  });

  it('classifies and redacts failed vendor diagnostics',async()=>{
    const{db,close}=makeTestDb();try{
      const profile=createExecutorProfile(db,{name:'Claude',manifestId:'claude-code-cli',config:{binaryPath:'/usr/local/bin/claude',provider:'claude-cli'}});
      const probe=await runConnectionProbe(db,{profileId:profile.id,force:true,runtime:{run:async()=>({exitCode:1,stdout:'',stderr:'401 authentication failed Authorization: Bearer secret-token',durationMs:3,filesAfter:[]})}});
      expect(probe.classification).toBe('authentication_failed');expect(probe.stderr).not.toContain('secret-token');
    }finally{close();}
  });

  it('starts probes asynchronously',async()=>{
    const{db,close}=makeTestDb();try{
      const profile=createExecutorProfile(db,{name:'Codex',manifestId:'codex-cli',config:{binaryPath:'/usr/local/bin/codex',provider:'codex-cli'}});
      const started=startConnectionProbe(db,{profileId:profile.id,force:true,runtime:{run:async()=>({exitCode:0,stdout:'MUSTER_CONNECTION_OK',stderr:'',durationMs:1,filesAfter:[]})}});
      expect(started.status).toBe('queued');await new Promise(resolve=>setTimeout(resolve,0));
      expect((db.prepare('SELECT status FROM connection_probe WHERE id=?').get(started.id)as any).status).toBe('connected');
    }finally{close();}
  });
});
