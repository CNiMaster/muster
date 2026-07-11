import type React from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';

type Manifest = { id:string;displayName:string;kind:'cli'|'api';officialSource:string;concurrency:string;managedInstall:{packageName:string}|null };
type Detection = {found:boolean;path:string|null;version:string|null;managed:boolean};
type Install = {id:string;manifestId:string;channel:string;packageName:string;targetDir:string;officialSource:string;confirmationToken:string;status:string;version:string|null;binaryPath:string|null;error:string|null};

export function ExecutorCenterPage():React.ReactElement {
  const qc=useQueryClient();
  const manifests=useQuery({queryKey:['executor-manifests'],queryFn:()=>api.get<Manifest[]>('/api/executors/manifests')});
  const [detections,setDetections]=useState<Record<string,Detection>>({});
  const [plan,setPlan]=useState<Install|null>(null);
  const detect=useMutation({mutationFn:(id:string)=>api.post<Detection>(`/api/executors/${id}/detect`),onSuccess:(result,id)=>setDetections((old)=>({...old,[id]:result})),onError:(e:any)=>toast('error',e.message??'检测失败')});
  const createPlan=useMutation({mutationFn:(id:string)=>api.post<Install>(`/api/executors/${id}/install-plan`,{channel:'stable'}),onSuccess:setPlan,onError:(e:any)=>toast('error',e.message??'无法创建安装计划')});
  const install=useMutation({mutationFn:(p:Install)=>api.post<Install>(`/api/executors/installs/${p.id}/execute`,{confirmationToken:p.confirmationToken}),onSuccess:(result)=>{setPlan(result);void qc.invalidateQueries({queryKey:['executor-profiles']});toast('success','执行器已安装并通过版本校验');},onError:(e:any)=>toast('error',e.message??'安装失败')});
  const login=useMutation({mutationFn:(p:Install)=>api.post<{launched:boolean}>(`/api/executors/installs/${p.id}/login`),onSuccess:()=>toast('success','已打开官方登录窗口，完成后回到 Muster 检测连接'),onError:(e:any)=>toast('error',e.message??'无法打开登录窗口')});
  return <div className="settings-page">
    <header className="page-header"><div><h1>执行器安装中心</h1><p className="subtitle">新 Mac 无需自行安装命令行工具。Muster 检测、安装、验证并管理自己的版本。</p></div></header>
    <Card title="推荐执行器"><div className="executor-grid">
      {(manifests.data??[]).map((m)=><article className="executor-card" key={m.id}>
        <div className="executor-card-head"><div><strong>{m.displayName}</strong><div className="muted">{m.kind==='cli'?'本地 CLI':'API 连接'} · {concurrencyLabel(m.concurrency)}</div></div><Badge tone={detections[m.id]?.found?'ok':'neutral'}>{detections[m.id]?.found?'已检测':'未检测'}</Badge></div>
        {detections[m.id]?.found&&<p className="diagnostic-text">{detections[m.id]!.version}<br/><span className="muted">{detections[m.id]!.path}</span></p>}
        <a href={m.officialSource} target="_blank" rel="noreferrer">查看官方来源</a>
        <div className="settings-primary-actions"><Button variant="ghost" onClick={()=>detect.mutate(m.id)} loading={detect.isPending}>检测</Button>{m.managedInstall&&<Button onClick={()=>createPlan.mutate(m.id)} loading={createPlan.isPending}>由 Muster 安装</Button>}</div>
      </article>)}
    </div></Card>
    {plan&&<Card title="确认安装">
      <div className="install-review"><p><strong>{plan.packageName}</strong></p><dl><dt>官方来源</dt><dd>{plan.officialSource}</dd><dt>安装位置</dt><dd>{plan.targetDir}</dd><dt>版本通道</dt><dd>{plan.channel}</dd><dt>状态</dt><dd>{plan.status}</dd>{plan.version&&<><dt>已验证版本</dt><dd>{plan.version}</dd></>}</dl><p className="muted">只写入 Muster 私有运行时目录，不修改系统 PATH，不使用 sudo。账号密码始终交给官方登录页面，Muster 不读取。</p>{plan.error&&<pre className="test-result-err">{plan.error}</pre>}<div className="settings-primary-actions">{(plan.status==='planned'||plan.status==='failed')&&<Button onClick={()=>install.mutate(plan)} loading={install.isPending}>确认并安装</Button>}{plan.status==='installed'&&<Button onClick={()=>login.mutate(plan)} loading={login.isPending}>开始官方登录</Button>}<Button variant="ghost" onClick={()=>setPlan(null)}>关闭</Button></div></div>
    </Card>}
  </div>;
}
function concurrencyLabel(value:string):string{return value==='parallel'?'支持员工并行':value==='profile-serial'?'同一配置串行':'全局串行';}
