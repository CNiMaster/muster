import type React from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  useProject,
  useCompany,
  useTasks,
  useThreads,
  useProjectUsage,
  useInspectorSuggestions,
  useAgents,
} from '../hooks/queries';
import { Card } from '../components/Card';
import { Badge, companyStateTone, stateLabel } from '../components/Badge';
import { EmptyState, Icons } from '../components/EmptyState';

export function DashboardPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const { data: project } = useProject(projectId);
  const { data: company } = useCompany(project?.companyId);
  const { data: tasks } = useTasks(projectId);
  const { data: threads } = useThreads(projectId);
  const { data: usage } = useProjectUsage(projectId);
  const { data: suggestions } = useInspectorSuggestions(projectId);
  const { data: agents } = useAgents(project?.companyId);

  // 统计指标
  const queueLength = tasks?.filter((t) => t.state === 'queued' || t.state === 'running').length ?? 0;
  const blockedCount = tasks?.filter((t) => t.state === 'blocked' || t.state === 'failed').length ?? 0;
  const mirrorCount = threads?.filter((t) => t.kind === 'mirror').length ?? 0;
  const activeWarnings = suggestions?.filter((s) => s.kind !== 'ok') ?? [];

  return (
    <div className="dashboard-page">
      <header className="page-header">
        <div>
          <h1>项目实时看板</h1>
          <p className="subtitle">项目：{project?.name ?? '...'}</p>
        </div>
        <div className="page-actions">
          <Link to={`/projects/${projectId}`}>
            <Badge tone={companyStateTone(company?.state ?? 'off')} dot={company?.state === 'online'}>
              公司状态: {company ? stateLabel(company.state) : '...'}
            </Badge>
          </Link>
        </div>
      </header>

      {/* 警告警告条 */}
      {activeWarnings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginBottom: 'var(--space-5)' }}>
          {activeWarnings.map((w) => (
            <div 
              key={w.id} 
              style={{
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid var(--err)',
                borderRadius: 'var(--radius-lg)',
                padding: 'var(--space-3) var(--space-4)',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                fontSize: 'var(--text-sm)'
              }}
            >
              <div style={{ flex: 1 }}>
                <strong style={{ color: 'var(--err)' }}>运营监察警报：</strong>
                <span className="muted">{w.message}</span>
              </div>
              <Badge tone="err">{w.kind.toUpperCase()}</Badge>
            </div>
          ))}
        </div>
      )}

      {/* 指标网格 */}
      <div className="usage-grid" style={{ marginBottom: 'var(--space-5)' }}>
        <Card className="mu-metric">
          <div className="mu-metric-label">积压任务 (Queued/Running)</div>
          <div className="mu-metric-value">{queueLength}</div>
          <div className="mu-metric-hint">排队待处理的任务数</div>
        </Card>

        <Card className="mu-metric">
          <div className="mu-metric-label">受阻任务 (Blocked/Failed)</div>
          <div className="mu-metric-value" style={{ color: blockedCount > 0 ? 'var(--err)' : 'inherit' }}>
            {blockedCount}
          </div>
          <div className="mu-metric-hint">由于冲突或失败被卡住的 Task</div>
        </Card>

        <Card className="mu-metric">
          <div className="mu-metric-label">当前镜像线程数</div>
          <div className="mu-metric-value">{mirrorCount}</div>
          <div className="mu-metric-hint">项目临时扩容线程</div>
        </Card>

        <Card className="mu-metric">
          <div className="mu-metric-label">Token 消耗总计</div>
          <div className="mu-metric-value">
            {((usage?.totalInputTokens ?? 0) + (usage?.totalOutputTokens ?? 0)).toLocaleString()}
          </div>
          <div className="mu-metric-hint">累计消耗 tokens</div>
        </Card>

        <Card className="mu-metric">
          <div className="mu-metric-label">累计费用</div>
          <div className="mu-metric-value">${(usage?.totalCostUSD ?? 0).toFixed(4)}</div>
          <div className="mu-metric-hint">基于实际运行所花 API 成本</div>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-5)' }}>
        {/* 左侧：运行线程 */}
        <Card title="项目运行线程" actions={<Badge>{threads?.length ?? 0}</Badge>}>
          {threads && threads.length === 0 ? (
            <EmptyState icon={Icons.empty} title="无运行线程" hint="公司上班后将自动为进入项目的员工开启线程。" />
          ) : (
            <ul className="entity-list">
              {threads?.map((t) => {
                const a = agents?.find((x) => x.id === t.agentId);
                const isRunning = t.state === 'running';
                return (
                  <li key={t.id}>
                    <div style={{ flex: 1 }}>
                      <strong>{a?.name ?? t.agentId}</strong>
                      <span className="muted" style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--text-xs)' }}>
                        [{a?.role ?? '未知岗位'}]
                      </span>
                    </div>
                    <Badge tone={t.kind === 'mirror' ? 'warn' : 'info'}>
                      {t.kind === 'mirror' ? '镜像线程' : '主线程'}
                    </Badge>
                    <Badge tone={isRunning ? 'ok' : 'neutral'} dot={isRunning}>
                      {t.state}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* 右侧：警报与监察摘要 */}
        <Card title="健康状态诊断">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div style={{
              padding: 'var(--space-3)',
              background: 'var(--bg-input)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)',
              fontSize: 'var(--text-sm)'
            }}>
              <strong>运营指标总结：</strong>
              <ul style={{ margin: '8px 0 0 16px', padding: 0 }} className="muted">
                <li>累计触发 Task 执行数：{tasks?.length ?? 0} 个</li>
                <li>完成率：{tasks?.length ? ((tasks.filter(t => t.state === 'completed').length / tasks.length) * 100).toFixed(1) : 0}%</li>
                <li>公司上班状态锁定：上班时锁定组织配置以确保安全</li>
              </ul>
            </div>

            <div style={{
              padding: 'var(--space-3)',
              background: 'var(--bg-input)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)',
              fontSize: 'var(--text-sm)'
            }}>
              <strong>诊断建议：</strong>
              <div style={{ marginTop: 'var(--space-2)' }}>
                {suggestions && suggestions.some(s => s.kind !== 'ok') ? (
                  <div className="muted">
                    检测到系统内存在健康或效率隐患，请根据顶部红色警告框中的具体建议，在组织架构、镜像线程或任务流程中做出调整。
                  </div>
                ) : (
                  <div style={{ color: 'var(--ok)' }}>
                    诊断全绿！当前项目运转健康，没有检测到任何队列堵塞、主线程闲置或无限追问循环的迹象。
                  </div>
                )}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
