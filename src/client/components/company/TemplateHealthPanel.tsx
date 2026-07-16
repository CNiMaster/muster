import type React from 'react';
import { Link } from 'react-router-dom';
import type { TemplateRuntimeHealthFinding } from '../../../shared/types';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Card } from '../Card';

export function TemplateHealthPanel({ findings, refreshing, onRefresh, onDismiss }: {
  findings: TemplateRuntimeHealthFinding[];
  refreshing: boolean;
  onRefresh: () => void;
  onDismiss: (findingId: string) => void;
}): React.ReactElement {
  return <Card id="template-health" title="模板运行健康" actions={<Button size="sm" variant="ghost" loading={refreshing} onClick={onRefresh}>重新检查</Button>}>
    {findings.length === 0 ? <div className="template-health-empty"><span aria-hidden="true">✓</span><div><strong>公司模板运行正常</strong><small>当前没有发现字段负责人、Skill 绑定或计划目标问题。</small></div></div> : <div className="template-health-list">
      {findings.map((finding) => <article key={finding.id} className={`template-health-finding is-${finding.severity}`}>
        <header><Badge tone={finding.severity === 'blocking' ? 'err' : finding.severity === 'warning' ? 'warn' : 'info'}>{finding.severity === 'blocking' ? '阻断' : finding.severity === 'warning' ? '提醒' : '信息'}</Badge><strong>{finding.title}</strong></header>
        <dl><div><dt>发生了什么</dt><dd>{finding.message}</dd></div><div><dt>会影响什么</dt><dd>{finding.impact}</dd></div><div><dt>为什么发生</dt><dd>{finding.cause}</dd></div><div><dt>建议怎么做</dt><dd>{finding.recommendation}</dd></div></dl>
        <footer>{finding.action && <Link className="mu-btn mu-btn-primary mu-btn-sm" to={finding.action.href}>{finding.action.label}</Link>}<Button size="sm" variant="ghost" onClick={() => onDismiss(finding.id)}>暂时忽略</Button></footer>
      </article>)}
    </div>}
  </Card>;
}
