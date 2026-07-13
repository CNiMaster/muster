import type React from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../Badge';
import { Card } from '../Card';
import { Select } from '../Form';
import type { EmploymentHealthDTO } from '../../../shared/types';

interface Option { id: string; name: string }
interface Employment { id:string;companyId:string;role:string;executorProfileId:string|null;permissionPolicyId:string|null;health?:EmploymentHealthDTO }

export function EmploymentCard(props:{employment:Employment;companyName:string;executors:Option[];policies:Option[];onExecutor:(id:string)=>void;onPermission:(id:string)=>void}):React.ReactElement{
  const health=props.employment.health ?? {state:'blocked',label:'状态未知',detail:'无法读取执行器健康状态。'};
  const completedAt='probeDetails' in health&&health.probeDetails?.completedAt?new Date(health.probeDetails.completedAt).toLocaleString():null;
  return <Card title={<Link to={`/companies/${props.employment.companyId}`}>{props.companyName}</Link>} actions={<Badge tone={health.state==='ready'?'ok':health.state==='checking'?'warn':'err'}>{health.label}</Badge>}>
    <p><strong>本公司岗位：</strong>{props.employment.role}</p>
    {'executorName' in health&&health.executorName?<p><strong>固定执行器：</strong>{health.executorName}{health.manifestId?` · ${health.manifestId}`:''}</p>:null}
    {'permission' in health&&health.permission?<p><strong>权限策略：</strong>{health.permission.name} · {health.permission.strategy} × {health.permission.scope}</p>:null}
    <p className="muted">{health.detail}</p>
    {'probeDetails' in health&&health.probeDetails?<p className="diagnostic-text">基础联通：{health.probeDetails.status}{health.probeDetails.version?` · ${health.probeDetails.version}`:''}{completedAt?` · ${completedAt}`:''}</p>:null}
    {'modelProbe' in health&&health.modelProbe?<p className="diagnostic-text">指定模型：{health.modelProbe.model??'未命名'} · {health.modelProbe.status}{health.modelProbe.classification?`（${health.modelProbe.classification}）`:''}</p>:null}
    {'reasons' in health&&health.reasons?.length?<ul className="diagnostic-list">{health.reasons.map((reason)=><li key={reason}>{reason}</li>)}</ul>:null}
    {'action' in health && health.action ? <p><Link to={health.action.href}>{health.action.label}</Link></p> : null}
    <div className="form-row"><Select aria-label={`${props.companyName} 执行器`} value={props.employment.executorProfileId??''} onChange={event=>event.target.value&&props.onExecutor(event.target.value)}><option value="">选择固定执行器</option>{props.executors.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select><Select aria-label={`${props.companyName} 权限`} value={props.employment.permissionPolicyId??''} onChange={event=>event.target.value&&props.onPermission(event.target.value)}><option value="">选择权限策略</option>{props.policies.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select></div>
  </Card>;
}
