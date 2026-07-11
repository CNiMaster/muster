import type React from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';import{Field,Input}from'../components/Form';

type Manifest={id:string;displayName:string;kind:'cli'|'api';officialSource:string;concurrency:string;officialInstall:{guideUrl:string;commands:string[];binaryName:string;loginCommand:string}|null};
type Detection={found:boolean;path:string|null;version:string|null;managed:false};
type Profile={id:string;name:string;manifestId:string;config:Record<string,unknown>};

export function ExecutorCenterPage():React.ReactElement{
  const qc=useQueryClient();
  const manifests=useQuery({queryKey:['executor-manifests'],queryFn:()=>api.get<Manifest[]>('/api/executors/manifests')});
  const profiles=useQuery({queryKey:['executor-profiles'],queryFn:()=>api.get<Profile[]>('/api/executors/profiles')});
  const[detections,setDetections]=useState<Record<string,Detection>>({});
  const[customName,setCustomName]=useState('自定义 CLI');const[customPath,setCustomPath]=useState('');const[customArgs,setCustomArgs]=useState('{prompt}');
  const detect=useMutation({mutationFn:(id:string)=>api.post<Detection>(`/api/executors/${id}/detect`),onSuccess:(result,id)=>setDetections((old)=>({...old,[id]:result})),onError:(e:any)=>toast('error',e.message??'检测失败')});
  const bind=useMutation({mutationFn:(id:string)=>api.post<Profile>(`/api/executors/${id}/bind-system`),onSuccess:(profile,_id)=>{void qc.invalidateQueries({queryKey:['executor-profiles']});toast('success',`已绑定 ${profile.name}`);},onError:(e:any)=>toast('error',e.message??'绑定失败')});
  const createCustom=useMutation({mutationFn:()=>api.post<Profile>('/api/executors/profiles',{name:customName,manifestId:'custom-cli',config:{binaryPath:customPath,provider:'custom-cli',customArgs:customArgs.split('\n').map((v)=>v.trim()).filter(Boolean)},concurrencyMode:'profile-serial'}),onSuccess:()=>{void qc.invalidateQueries({queryKey:['executor-profiles']});toast('success','自定义 CLI 档案已创建');},onError:(e:any)=>toast('error',e.message??'创建失败')});
  const copy=async(command:string):Promise<void>=>{await navigator.clipboard.writeText(command);toast('success','官方安装命令已复制');};
  return <div className="settings-page">
    <header className="page-header"><div><h1>执行器接入中心</h1><p className="subtitle">检测 Mac 上的官方 CLI；未安装时按官方说明安装，完成后回来一键复检并绑定。</p></div></header>
    <Card title="CLI 与 API 执行器"><div className="executor-grid">{(manifests.data??[]).map((manifest)=>{
      const detection=detections[manifest.id];const bound=profiles.data?.some((profile)=>profile.manifestId===manifest.id&&(!detection?.path||profile.config.binaryPath===detection.path));
      return <article className="executor-card" key={manifest.id}><div className="executor-card-head"><div><strong>{manifest.displayName}</strong><div className="muted">{manifest.kind==='cli'?'官方系统安装':'API 连接'} · {concurrencyLabel(manifest.concurrency)}</div></div><Badge tone={bound?'ok':detection?.found?'info':'neutral'}>{bound?'已绑定':detection?.found?'已安装':'待检测'}</Badge></div>
        {detection?.found?<div><p className="diagnostic-text">{detection.version}<br/><span className="muted">{detection.path}</span></p>{manifest.officialInstall&&<div className="install-command"><code>{manifest.officialInstall.loginCommand}</code><Button size="sm" variant="ghost" onClick={()=>void copy(manifest.officialInstall!.loginCommand)}>复制登录命令</Button></div>}</div>:manifest.officialInstall&&<div className="official-install-guide"><p className="muted">Muster 不内置或复制 CLI，请选择官方支持的安装方式：</p>{manifest.officialInstall.commands.map((command)=><div className="install-command" key={command}><code>{command}</code><Button size="sm" variant="ghost" onClick={()=>void copy(command)}>复制</Button></div>)}</div>}
        <a href={manifest.officialInstall?.guideUrl??manifest.officialSource} target="_blank" rel="noreferrer">打开官方安装说明</a>
        <div className="settings-primary-actions"><Button variant="ghost" onClick={()=>detect.mutate(manifest.id)} loading={detect.isPending}>检测系统安装</Button>{detection?.found&&!bound&&<Button onClick={()=>bind.mutate(manifest.id)} loading={bind.isPending}>绑定此安装</Button>}</div>
      </article>;
    })}</div></Card><Card title="接入其他 CLI" className="section"><p className="muted">参数每行一项，只支持整项占位符：{'{prompt}'}、{'{cwd}'}、{'{taskId}'}、{'{sessionId}'}。Muster 使用参数数组启动，不经过 shell。</p><div className="settings-field-grid"><Field label="档案名称"><Input value={customName} onChange={(e)=>setCustomName(e.target.value)}/></Field><Field label="可执行文件绝对路径"><Input value={customPath} onChange={(e)=>setCustomPath(e.target.value)} placeholder="/usr/local/bin/my-agent"/></Field><Field label="参数模板（每行一项）"><textarea value={customArgs} onChange={(e)=>setCustomArgs(e.target.value)}/></Field></div><Button onClick={()=>createCustom.mutate()} disabled={!customPath.trim()} loading={createCustom.isPending}>创建自定义执行器</Button></Card>
    <Card title="接入原则"><ul><li>CLI 由官方安装到系统位置，登录、签名和自动更新沿用官方机制。</li><li>Muster 只记录经过检测的可执行文件路径和版本，不保存账号密码。</li><li>员工可共用同一系统 CLI，但会话、工作目录、日志、记忆和中止状态仍按员工与 Task 隔离。</li></ul></Card>
  </div>;
}
function concurrencyLabel(value:string):string{return value==='parallel'?'支持员工并行':value==='profile-serial'?'同一配置串行':'全局串行';}
