import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { getExecutorManifest } from '../executors/manifests';
import { createExecutorProfile, listExecutorProfiles, type ExecutorProfile } from './executor-profile';

const execFileAsync=promisify(execFile);
export interface DiscoveryRuntime { run:(command:string,args:string[])=>Promise<{stdout:string;stderr:string;exitCode:number}>;which:(command:string)=>Promise<string|null> }
const defaultRuntime:DiscoveryRuntime={run:async(command,args)=>{try{const result=await execFileAsync(command,args,{timeout:5000});return{stdout:result.stdout,stderr:result.stderr,exitCode:0};}catch(error:any){return{stdout:error.stdout??'',stderr:error.stderr??error.message,exitCode:1};}},which:async(command)=>{try{const result=await execFileAsync('/usr/bin/which',[command],{timeout:3000});return result.stdout.trim()||null;}catch{return null;}}};
export async function detectSystemExecutor(manifestId:string,runtime:DiscoveryRuntime=defaultRuntime):Promise<{found:boolean;path:string|null;version:string|null;managed:false}>{const manifest=getExecutorManifest(manifestId);if(!manifest.detection)return{found:false,path:null,version:null,managed:false};const path=await runtime.which(manifest.detection.command);if(!path)return{found:false,path:null,version:null,managed:false};const result=await runtime.run(path,manifest.detection.args);return{found:result.exitCode===0,path,version:(result.stdout||result.stderr).trim()||null,managed:false};}
export async function bindDetectedSystemExecutor(db:DB,manifestId:string,runtime:DiscoveryRuntime=defaultRuntime):Promise<ExecutorProfile>{const manifest=getExecutorManifest(manifestId);const detection=await detectSystemExecutor(manifestId,runtime);if(!detection.found||!detection.path)throw new AppError(ErrorCode.NOT_FOUND,`${manifest.displayName} 尚未安装，请先按官方说明完成安装`);const existing=listExecutorProfiles(db).find((profile)=>profile.manifestId===manifestId&&profile.config.binaryPath===detection.path);if(existing)return existing;return createExecutorProfile(db,{name:`${manifest.displayName} (${detection.version??'系统安装'})`,manifestId,config:{binaryPath:detection.path,provider:providerForManifest(manifestId)},install:{managed:false,source:'system',detectedVersion:detection.version}});}
function providerForManifest(id:string):string{return id==='claude-code-cli'?'claude-cli':id==='openai-compatible-api'?'openai':id==='gemini-api'?'gemini':id;}
