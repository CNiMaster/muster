import type React from 'react';
import { Link } from 'react-router-dom';
import type { CompanyCockpitDTO } from '../../../shared/types';
import { Badge, companyStateTone, stateLabel } from '../Badge';
import { Card } from '../Card';
import { BlockingIssues } from '../BlockingIssues';
import { EmptyState, Icons } from '../EmptyState';
import { CardSkeleton } from '../Skeleton';

export function CompanyAttention({ companyName, companyState, cockpit }: { companyName: string; companyState: string; cockpit?: CompanyCockpitDTO }): React.ReactElement {
  if (!cockpit) return <div className="form-stack"><CardSkeleton /></div>;
  const blockedEmployees = cockpit.employees.blocked;
  const pendingApprovals = cockpit.approvals.pending;
  const attentionProjects = cockpit.projects.attention;
  const total = pendingApprovals + attentionProjects + cockpit.risks.length + (blockedEmployees > 0 ? 1 : 0);

  return <div className="form-stack company-attention-page">
    <header className="work-surface-heading">
      <div>
        <h1>{companyName} · 需要处理</h1>
        <div className="subtitle" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Badge tone={companyStateTone(companyState)} dot={companyState === 'online'}>{stateLabel(companyState)}</Badge>
          <span className="muted">{total > 0 ? `${total} 项待处理` : '一切就绪'}</span>
        </div>
      </div>
    </header>

    {total === 0 && <Card title="没有需要处理的事项"><EmptyState icon={Icons.empty} title="一切正常" hint="没有待审批、阻塞或需要关注的问题。可以继续当前工作。" /></Card>}

    {pendingApprovals > 0 && <Card title={`权限审批（${pendingApprovals}）`} actions={<Link className="mu-btn mu-btn-primary mu-btn-sm" to="/permissions">去审批 →</Link>}>
      <p className="muted">智能体执行命令或访问敏感操作时，等待你的决定。</p>
    </Card>}

    {blockedEmployees > 0 && <Card title={`智能体配置缺口（${blockedEmployees}）`} actions={<Link className="mu-btn mu-btn-sm" to={`/companies/${cockpit.companyId}?view=team`}>配置智能体 →</Link>}>
      <p className="muted">有智能体缺少执行器、权限策略或能力绑定，无法开始工作。</p>
    </Card>}

    {attentionProjects > 0 && <Card title={`项目需要关注（${attentionProjects}）`} actions={<Link className="mu-btn mu-btn-sm" to={`/companies/${cockpit.companyId}?view=projects`}>查看项目 →</Link>}>
      <p className="muted">有项目处于需要人工确认或关注的状态。</p>
    </Card>}

    <BlockingIssues issues={cockpit.risks.map((risk) => ({ id: `${risk.kind}:${risk.label}`, what: risk.label, why: risk.kind === 'approval' ? '操作超出当前自动允许范围' : risk.kind === 'executor' ? '智能体执行器、权限或联通状态未准备好' : risk.kind === 'role-gap' ? '工作台模板要求的岗位尚未覆盖' : '项目处于需要人工确认的状态', impact: risk.kind === 'approval' || risk.kind === 'executor' ? '相关智能体工作单暂时不能继续' : '工作台计划可能无法按预期推进', action: { label: '处理', href: risk.href } }))} />

    <Card title="下一步行动">
      <div className="next-action-inline"><div><strong>{cockpit.nextAction.label}</strong><p className="muted">{cockpit.nextAction.description}</p></div><Link className="mu-btn mu-btn-primary" to={cockpit.nextAction.href}>{cockpit.nextAction.label} →</Link></div>
    </Card>
  </div>;
}
