import type React from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../Badge';
import { Card } from '../Card';
import type { EmploymentHealthDTO } from '../../../shared/types';

interface Option { id: string; name: string }
interface Employment { id:string;companyId:string;role:string;executorProfileId:string|null;permissionPolicyId:string|null;health?:EmploymentHealthDTO }

/**
 * 公司任职卡片（员工档案页用）。
 * 执行器/权限的绑定统一在公司「组织架构」页操作，这里只读展示当前绑定与健康状态，
 * 并提供跳转链接，避免与公司页形成重复入口。
 */
export function EmploymentCard(props:{employment:Employment;companyName:string;executors:Option[];policies:Option[];onExecutor?:(id:string)=>void;onPermission?:(id:string)=>void}):React.ReactElement{
  const health=props.employment.health ?? {state:'blocked',label:'状态未知',detail:'无法读取执行器健康状态。'};
  const completedAt='probeDetails' in health&&health.probeDetails?.completedAt?new Date(health.probeDetails.completedAt).toLocaleString():null;
  const executorName = props.executors.find((e) => e.id === props.employment.executorProfileId)?.name;
  const policy = props.policies.find((p) => p.id === props.employment.permissionPolicyId);
  return <Card title={<Link to={`/companies/${props.employment.companyId}?view=team`}>{props.companyName}</Link>} actions={<Badge tone={health.state==='ready'?'ok':health.state==='checking'?'warn':'err'}>{health.label}</Badge>}>
    <p><strong>本公司岗位：</strong>{props.employment.role}</p>
    <p><strong>固定执行器：</strong>{executorName ?? '未绑定'}{'executorName' in health&&health.executorName&&health.manifestId?` · ${health.manifestId}`:''}</p>
    <p><strong>权限策略：</strong>{policy ? `${policy.name}` : '未绑定'}{'permission' in health&&health.permission?` · ${health.permission.strategy} × ${health.permission.scope}`:''}</p>
    <p className="muted">{health.detail}</p>
    {'probeDetails' in health&&health.probeDetails?<p className="diagnostic-text">基础联通：{health.probeDetails.status}{health.probeDetails.version?` · ${health.probeDetails.version}`:''}{completedAt?` · ${completedAt}`:''}</p>:null}
    {'modelProbe' in health&&health.modelProbe?<p className="diagnostic-text">指定模型：{health.modelProbe.model??'未命名'} · {health.modelProbe.status}{health.modelProbe.classification?`（${health.modelProbe.classification}）`:''}</p>:null}
    {'reasons' in health&&health.reasons?.length?<ul className="diagnostic-list">{health.reasons.map((reason)=><li key={reason}>{reason}</li>)}</ul>:null}
    {'action' in health && health.action ? <p><Link to={health.action.href}>{health.action.label}</Link></p> : null}
    <p className="muted" style={{ marginTop: 8 }}>
      执行器与权限的绑定/修改请到{' '}
      <Link to={`/companies/${props.employment.companyId}?view=team`}>该公司组织架构</Link>
      {' '}（需公司下班）。
    </p>
  </Card>;
}
