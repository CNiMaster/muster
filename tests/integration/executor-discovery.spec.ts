import {describe,expect,it,vi} from 'vitest';
import {makeTestDb} from './setup';
import {bindDetectedSystemExecutor,detectSystemExecutor,testExecutorProfileConnection} from '../../src/server/domain/executor-discovery';

describe('official system executor onboarding',()=>{
  it('detects, binds, and diagnoses an existing CLI without copying it',async()=>{
    const{db,close}=makeTestDb();
    try{
      const runtime={which:vi.fn(async()=>'/opt/homebrew/bin/codex'),run:vi.fn(async(_bin:string,args:string[])=>({stdout:args[0]==='login'?'Logged in with ChatGPT':'codex-cli 0.144.1',stderr:'',exitCode:0}))};
      expect((await detectSystemExecutor('codex-cli',runtime)).managed).toBe(false);
      const profile=await bindDetectedSystemExecutor(db,'codex-cli',runtime);
      expect(profile.config.binaryPath).toBe('/opt/homebrew/bin/codex');
      expect(profile.install.source).toBe('system');
      expect((await bindDetectedSystemExecutor(db,'codex-cli',runtime)).id).toBe(profile.id);
      const connection=await testExecutorProfileConnection(db,profile.id,runtime);
      expect(connection.version.success).toBe(true);
      expect(connection.authentication.output).toContain('Logged in');
    }finally{close();}
  });
  it('does not create a binding when the official CLI is missing',async()=>{const{db,close}=makeTestDb();try{await expect(bindDetectedSystemExecutor(db,'opencode-cli',{which:vi.fn(async()=>null),run:vi.fn()} as any)).rejects.toThrow(/尚未安装/);}finally{close();}});
});
