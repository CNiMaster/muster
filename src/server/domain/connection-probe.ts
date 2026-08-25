import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../db/client';
import { shortId } from '../../shared/utils';
import { getExecutorProfile } from './executor-profile';
import { getExecutorManifest, type ExecutorManifest } from '../executors/manifests';
import { profilePrimaryModel } from '../../shared/executor';
import { resolveCliEnvironment } from '../executors/cli-environment';
import { redactSensitiveText } from '../../shared/redaction';
import { runApiCapabilityProbe, ApiProbeError, type CapabilityProbeResult } from './capability-probe';
import { PROVIDER_DEFAULT_API_KEY_ENV } from '../executors/provider';
import { resolveExecutorCredentialEnv } from './credential-store';

const execFileAsync = promisify(execFile);
const OK = 'MUSTER_CONNECTION_OK';
export type ProbeKind = 'connectivity' | 'model' | 'capability';
export type ProbeClassification = 'not_found' | 'version_failed' | 'authentication_failed' | 'model_failed' | 'network_failed' | 'permission_bridge_failed' | 'timeout' | 'invalid_output' | 'mutated_workspace' | 'failed';
export interface ConnectionProbe { id:string; executorProfileId:string; cacheKey:string; kind:ProbeKind; model:string|null; status:'queued'|'testing'|'connected'|'failed'; classification:ProbeClassification|null; version:string|null; stdout:string; stderr:string; durationMs:number; startedAt:string|null; completedAt:string|null; createdAt:string; capability:CapabilityProbeResult|null }
type Row = { id: string; executor_profile_id: string; cache_key: string; kind?:ProbeKind; model?:string|null; status:ConnectionProbe['status']; classification:ProbeClassification|null; version:string|null; stdout:string; stderr:string; duration_ms:number; started_at:string|null; completed_at:string|null; created_at:string; capability_json?:string|null };
export interface ProbeRuntime { run:(input:{ binary:string; manifest:Readonly<ExecutorManifest>; cwd:string; prompt:string; timeoutMs:number; kind:ProbeKind; model?:string; args:string[]; env:NodeJS.ProcessEnv })=>Promise<{exitCode:number;stdout:string;stderr:string;durationMs:number;filesAfter:string[]}> }

const fromRow = (row:Row):ConnectionProbe => ({ id:row.id, executorProfileId:row.executor_profile_id, cacheKey:row.cache_key, kind:row.kind??'connectivity', model:row.model??null, status:row.status, classification:row.classification, version:row.version, stdout:row.stdout, stderr:row.stderr, durationMs:row.duration_ms, startedAt:row.started_at, completedAt:row.completed_at, createdAt:row.created_at, capability:row.capability_json?JSON.parse(row.capability_json):null });
const defaultRuntime:ProbeRuntime = { run:async input => { const before=Date.now(); try { const result=await execFileAsync(input.binary,input.args,{cwd:input.cwd,env:input.env,timeout:input.timeoutMs,maxBuffer:4*1024*1024}); return {exitCode:0,stdout:result.stdout,stderr:result.stderr,durationMs:Date.now()-before,filesAfter:readdirSync(input.cwd)}; } catch(error:any) { return {exitCode:typeof error.code==='number'?error.code:1,stdout:error.stdout??'',stderr:error.stderr??error.message,durationMs:Date.now()-before,filesAfter:readdirSync(input.cwd)}; } } };

function probeArgs(id:string,prompt:string,model?:string):string[] { const modelArgs=model?['--model',model]:[]; if(id==='codex-cli')return['exec','-s','read-only','-a','never',...modelArgs,prompt]; if(id==='claude-code-cli')return['-p',prompt,'--output-format','text','--tools','',...modelArgs]; if(id==='antigravity-cli')return['--print',prompt,'--sandbox','--print-timeout','60s']; if(id==='opencode-cli')return['run',prompt,'--format','json']; return[]; }
export function getConnectionProbe(db:DB,id:string):ConnectionProbe { const row=db.prepare('SELECT * FROM connection_probe WHERE id=?').get(id) as Row|undefined; if(!row)throw new Error(`connection probe not found: ${id}`); return fromRow(row); }
export async function runConnectionProbe(db:DB,input:{profileId:string;force:boolean;kind?:ProbeKind;runtime?:ProbeRuntime;now?:Date;probeId?:string;modelOverride?:string}):Promise<ConnectionProbe> {
  const profile=getExecutorProfile(db,input.profileId); const manifest=getExecutorManifest(profile.manifestId); const binary=String(profile.config.binaryPath??''); const version=profile.install.detectedVersion??null; const kind=input.kind??'connectivity';
  // capability/model 探针也按 model 缓存（不同 model 能力不同）；R2a：apiFormat 入缓存键（不同请求形状能力不同）
  // R5：模型读取统一走主模型（models[0]，兼容旧 model 单键）；model 探针支持按 chips 指定模型单独触发
  const primaryModel=profilePrimaryModel(profile.config)??null;
  const model=(kind==='model'||kind==='capability')?(input.modelOverride??primaryModel??undefined):undefined;
  if(kind==='model'&&!model)throw new Error('执行器未配置指定模型');
  const apiFormat=kind==='capability'&&profile.config.apiFormat==='responses'?'responses':null;
  const cacheKey=JSON.stringify([kind,binary,version,model??null,apiFormat,'login-shell']); const now=input.now??new Date();
  if(!input.force){const cached=db.prepare("SELECT * FROM connection_probe WHERE executor_profile_id=? AND cache_key=? AND status='connected' AND completed_at>=? ORDER BY completed_at DESC LIMIT 1").get(profile.id,cacheKey,new Date(now.getTime()-86_400_000).toISOString())as Row|undefined;if(cached)return fromRow(cached);}
  const id=input.probeId??shortId('probe_'); const created=now.toISOString(); db.prepare("INSERT OR IGNORE INTO connection_probe (id,executor_profile_id,cache_key,kind,model,status,version,created_at) VALUES (?,?,?,?,?,'queued',?,?)").run(id,profile.id,cacheKey,kind,model??null,version,created); db.prepare("UPDATE connection_probe SET status='testing',started_at=? WHERE id=?").run(created,id);
  // 能力探针：仅 API 型执行器（HTTP 探测，无需临时目录/execFile）
  if (kind === 'capability') {
    if (manifest.kind !== 'api') {
      db.prepare("UPDATE connection_probe SET status='failed',classification='failed',stderr=?,duration_ms=?,completed_at=? WHERE id=?").run('能力探针仅适用于 API 型执行器（openai-compatible / gemini）', 0, now.toISOString(), id);
      return getConnectionProbe(db,id);
    }
    const provider = manifest.id === 'gemini-api' ? 'gemini' : 'openai';
    const profileRef = (profile.credentialRef?.kind === 'env' && profile.credentialRef.reference) ? profile.credentialRef.reference : undefined;
    const apiKeyEnv = resolveExecutorCredentialEnv(db, null, provider, undefined, PROVIDER_DEFAULT_API_KEY_ENV[provider], profileRef);
    const apiKey = apiKeyEnv ? (process.env[apiKeyEnv] ?? '') : '';
    const startedAt = Date.now();
    try {
      const result = await runApiCapabilityProbe({
        provider,
        baseURL: typeof profile.config.baseURL === 'string' ? profile.config.baseURL : undefined,
        model: model ?? undefined,
        apiKey,
        timeoutMs: 60_000,
        ...(apiFormat ? { apiFormat } : {}),
      });
      const durationMs = Date.now() - startedAt;
      db.prepare("UPDATE connection_probe SET status='connected',classification=null,capability_json=?,duration_ms=?,completed_at=? WHERE id=?").run(JSON.stringify(result), durationMs, now.toISOString(), id);
      return getConnectionProbe(db,id);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const classification = error instanceof ApiProbeError ? error.classification : 'failed';
      db.prepare("UPDATE connection_probe SET status='failed',classification=?,stderr=?,duration_ms=?,completed_at=? WHERE id=?").run(classification, redact(error instanceof Error ? error.message : String(error)), durationMs, now.toISOString(), id);
      return getConnectionProbe(db,id);
    }
  }
  const cwd=mkdtempSync(join(tmpdir(),'muster-probe-'));
  try { const prompt=`只回复 ${OK}，不要调用工具，不要读取或修改文件。`; const result=await(input.runtime??defaultRuntime).run({binary,manifest,cwd,prompt,timeoutMs:60_000,kind,model,args:probeArgs(manifest.id,prompt,model),env:input.runtime?{}:await resolveCliEnvironment()}); const cleanOut=redact(result.stdout),cleanErr=redact(result.stderr); const classification=result.exitCode===0?(result.filesAfter.length?'mutated_workspace':cleanOut.includes(OK)?null:'invalid_output'):classify(`${cleanOut}\n${cleanErr}`); const status=classification?'failed':'connected'; db.prepare('UPDATE connection_probe SET status=?,classification=?,stdout=?,stderr=?,duration_ms=?,completed_at=? WHERE id=?').run(status,classification,cleanOut,cleanErr,result.durationMs,now.toISOString(),id); return getConnectionProbe(db,id); } finally { rmSync(cwd,{recursive:true,force:true}); }
}
export function startConnectionProbe(db:DB,input:{profileId:string;force:boolean;kind?:ProbeKind;runtime?:ProbeRuntime;modelOverride?:string}):ConnectionProbe { const profile=getExecutorProfile(db,input.profileId); const kind=input.kind??'connectivity'; const model=(kind==='model'||kind==='capability')?(input.modelOverride??(profilePrimaryModel(profile.config)??null)):null; const apiFormat=kind==='capability'&&profile.config.apiFormat==='responses'?'responses':null; const key=JSON.stringify([kind,profile.config.binaryPath??'',profile.install.detectedVersion??null,model,apiFormat,'login-shell']); const id=shortId('probe_'),now=new Date().toISOString(); db.prepare("INSERT INTO connection_probe (id,executor_profile_id,cache_key,kind,model,status,version,created_at) VALUES (?,?,?,?,?,'queued',?,?)").run(id,profile.id,key,kind,model,profile.install.detectedVersion??null,now); queueMicrotask(()=>{void runConnectionProbe(db,{...input,kind,probeId:id}).catch(error=>{if(db.open)db.prepare("UPDATE connection_probe SET status='failed',classification='failed',stderr=?,completed_at=? WHERE id=?").run(redact(String(error)),new Date().toISOString(),id);});}); return getConnectionProbe(db,id); }
function classify(text:string):ProbeClassification { const value=text.toLowerCase(); if(/requires a newer version|upgrade to the latest|version.*too old/.test(value))return'version_failed'; if(/auth|login|401|unauthorized|not logged/.test(value))return'authentication_failed'; if(/model.*(not found|unsupported|access)|invalid.*model|issue with the selected model/.test(value))return'model_failed'; if(/network|dns|econn|tls|proxy|retry/.test(value))return'network_failed'; if(/timeout|timed out/.test(value))return'timeout'; return'failed'; }
export const redact=redactSensitiveText;
