import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '../Card';
import { Badge } from '../Badge';
import type { CompanyCockpitDTO } from '../../../shared/types';
import type { StatusBoard as StatusBoardDTO } from '../../hooks/queries';
import { StatusBoard } from '../StatusBoard';
import { SeatWall } from './SeatWall';
import { BlockingIssues } from '../BlockingIssues';

export function CompanyOverview({ cockpit, statusBoard, statusBoardLoading = false }: { cockpit: CompanyCockpitDTO; statusBoard?: StatusBoardDTO; statusBoardLoading?: boolean }): React.ReactElement {
  const [view, setView] = useState<'seat' | 'table'>('seat');
  return <div className="form-stack"><Card title="公司驾驶舱" actions={<Badge tone={cockpit.employees.blocked ? 'warn' : 'ok'}>{cockpit.employees.blocked ? `${cockpit.employees.blocked} 位员工待配置` : '运行准备正常'}</Badge>}>
    <div className="dashboard-metrics">
      <div><strong>{cockpit.employees.online}</strong><span className="muted">在线员工</span></div>
      <div><strong>{cockpit.projects.active}</strong><span className="muted">运行项目</span></div>
      <div><strong>{cockpit.employees.blocked}</strong><span className="muted">运行问题</span></div>
      <div><strong>{cockpit.approvals.pending}</strong><span className="muted">待审批</span></div>
    </div>
    <div className="next-action-inline"><div><strong>推荐下一步</strong><p className="muted">{cockpit.nextAction.description}</p></div><Link className="mu-btn mu-btn-primary" to={cockpit.nextAction.href}>{cockpit.nextAction.label}</Link></div>
    <BlockingIssues issues={cockpit.risks.map((risk)=>({id:`${risk.kind}:${risk.label}`,what:risk.label,why:risk.kind==='approval'?'操作超出当前自动允许范围':risk.kind==='executor'?'员工执行器、权限或联通状态未准备好':risk.kind==='role-gap'?'公司模板要求的岗位尚未覆盖':'项目处于需要人工确认的状态',impact:risk.kind==='approval'||risk.kind==='executor'?'相关员工工作单暂时不能继续':'公司计划可能无法按预期推进',action:{label:'处理',href:risk.href}}))}/>
  </Card>
  <Card title="员工工位" actions={<div className="seat-view-toggle">
    <button type="button" className={`seat-view-btn ${view === 'seat' ? 'is-active' : ''}`} onClick={() => setView('seat')}>工位</button>
    <button type="button" className={`seat-view-btn ${view === 'table' ? 'is-active' : ''}`} onClick={() => setView('table')}>明细</button>
    <Badge tone="info">实时</Badge>
  </div>}>
    {view === 'seat'
      ? <SeatWall data={statusBoard} loading={statusBoardLoading} companyState={cockpit.companyState} density="standard" />
      : <StatusBoard data={statusBoard} loading={statusBoardLoading} companyState={cockpit.companyState} />}
  </Card>
  </div>;
}
