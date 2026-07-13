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
  return <Card title={<Link to={`/companies/${props.employment.companyId}`}>{props.companyName}</Link>} actions={<Badge tone={health.state==='ready'?'ok':health.state==='checking'?'warn':'err'}>{health.label}</Badge>}>
    <p><strong>本公司岗位：</strong>{props.employment.role}</p><p className="muted">{health.detail}</p>
    {'action' in health && health.action ? <p><Link to={health.action.href}>{health.action.label}</Link></p> : null}
    <div className="form-row"><Select aria-label={`${props.companyName} 执行器`} value={props.employment.executorProfileId??''} onChange={event=>event.target.value&&props.onExecutor(event.target.value)}><option value="">选择固定执行器</option>{props.executors.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select><Select aria-label={`${props.companyName} 权限`} value={props.employment.permissionPolicyId??''} onChange={event=>event.target.value&&props.onPermission(event.target.value)}><option value="">选择权限策略</option>{props.policies.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select></div>
  </Card>;
}
