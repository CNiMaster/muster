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
  useProjectEvents,
  useStatusBoard,
  useArtifacts,
} from '../hooks/queries';
import { Card } from '../components/Card';
import { Badge, companyStateTone, stateLabel } from '../components/Badge';
import { EmptyState, Icons } from '../components/EmptyState';
import { Skeleton, CardSkeleton } from '../components/Skeleton';

// Task 10 态 → 展示色 + 中文标签
const STATE_META: Record<string, { tone: string; label: string }> = {
  queued: { tone: 'var(--info)', label: '排队' },
  claimed: { tone: 'var(--warn)', label: '已领' },
  running: { tone: 'var(--accent)', label: '执行中' },
  waiting_input: { tone: 'var(--warn)', label: '追问中' },
  waiting_dependency: { tone: 'var(--info)', label: '等依赖' },
  paused: { tone: 'var(--fg-subtle)', label: '已暂停' },
  blocked: { tone: 'var(--err)', label: '阻塞' },
  completed: { tone: 'var(--ok)', label: '已完成' },
  failed: { tone: 'var(--err)', label: '失败' },
  cancelled: { tone: 'var(--fg-subtle)', label: '已取消' },
};

// FeedEvent kind → 色 + 中文
const EVENT_META: Record<string, { tone: string; label: string }> = {
  created: { tone: 'var(--info)', label: '创建' },
  claimed: { tone: 'var(--warn)', label: '领取' },
  running: { tone: 'var(--accent)', label: '开始' },
  completed: { tone: 'var(--ok)', label: '完成' },
  failed: { tone: 'var(--err)', label: '失败' },
  blocked: { tone: 'var(--err)', label: '阻塞' },
  waiting_input: { tone: 'var(--warn)', label: '追问' },
  escalated: { tone: 'var(--err)', label: '上报' },
  spawned_child: { tone: 'var(--info)', label: '派发' },
  cancelled: { tone: 'var(--fg-subtle)', label: '取消' },
  lease_recovered: { tone: 'var(--warn)', label: '租约恢复' },
  rolled_back: { tone: 'var(--warn)', label: '回滚' },
};

// 监察建议 kind → 色 + 中文
const SUGGESTION_META: Record<string, { tone: string; label: string }> = {
  congestion: { tone: 'var(--err)', label: '拥堵' },
  absence: { tone: 'var(--warn)', label: '缺席' },
  loop: { tone: 'var(--err)', label: '追问循环' },
  suggest_mirror: { tone: 'var(--info)', label: '建议扩容' },
  stuck: { tone: 'var(--err)', label: '心跳停滞' },
  ok: { tone: 'var(--ok)', label: '正常' },
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function DashboardPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const { data: project, isLoading: projectLoading } = useProject(projectId);
  const { data: company } = useCompany(project?.companyId);
  const { data: tasks } = useTasks(projectId);
  const { data: threads } = useThreads(projectId);
  const { data: usage } = useProjectUsage(projectId);
  const { data: suggestions } = useInspectorSuggestions(projectId);
  const { data: agents } = useAgents(project?.companyId);
  const { data: events } = useProjectEvents(projectId);
  const { data: statusBoard } = useStatusBoard(project?.companyId);
  const { data: artifacts } = useArtifacts(projectId);

  const coreLoading = projectLoading && !project;

  // 统计
  const queueLength = tasks?.filter((t) => t.state === 'queued' || t.state === 'running').length ?? 0;
  const blockedCount = tasks?.filter((t) => t.state === 'blocked' || t.state === 'failed').length ?? 0;
  const mirrorCount = threads?.filter((t) => t.kind === 'mirror').length ?? 0;
  const activeWarnings = suggestions?.filter((s) => s.kind !== 'ok') ?? [];
  const completedTasks = tasks?.filter((t) => t.state === 'completed').length ?? 0;
  const completionRate = tasks?.length ? (completedTasks / tasks.length) * 100 : 0;

  // 状态分布
  const stateBuckets = new Map<string, number>();
  for (const t of tasks ?? []) {
    stateBuckets.set(t.state, (stateBuckets.get(t.state) ?? 0) + 1);
  }
  const totalTasks = tasks?.length ?? 0;

  // byModel 排序
  const modelEntries = usage?.byModel
    ? Object.entries(usage.byModel).sort((a, b) => b[1].costUSD - a[1].costUSD)
    : [];

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

      {/* 首次加载骨架屏 */}
      {coreLoading && (
        <div className="mu-skel-stack">
          <div className="usage-grid">
            {Array.from({ length: 5 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
          <div style={{ height: 'var(--space-5)' }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-5)' }}>
            <CardSkeleton />
            <CardSkeleton />
          </div>
        </div>
      )}

      {/* 警告条 */}
      {activeWarnings.length > 0 && (
        <div className="dashboard-warnings">
          {activeWarnings.map((w) => {
            const meta = SUGGESTION_META[w.kind] ?? { tone: 'var(--err)', label: w.kind };
            return (
              <div key={w.id} className="dashboard-warning-item">
                <span className="dashboard-warning-dot" style={{ background: meta.tone }} />
                <div style={{ flex: 1 }}>
                  <strong style={{ color: meta.tone }}>{meta.label}</strong>
                  <span className="muted" style={{ marginLeft: 8 }}>{w.message}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 主内容 */}
      {!coreLoading && (
        <>
          {/* 指标网格 */}
          <div className="usage-grid" style={{ marginBottom: 'var(--space-5)' }}>
            <Card className="mu-metric">
              <div className="mu-metric-label">积压任务</div>
              <div className="mu-metric-value">{queueLength}</div>
              <div className="mu-metric-hint">Queued / Running</div>
            </Card>

            <Card className="mu-metric">
              <div className="mu-metric-label">受阻任务</div>
              <div className="mu-metric-value" style={{ color: blockedCount > 0 ? 'var(--err)' : 'inherit' }}>
                {blockedCount}
              </div>
              <div className="mu-metric-hint">Blocked / Failed</div>
            </Card>

            <Card className="mu-metric">
              <div className="mu-metric-label">完成率</div>
              <div className="mu-metric-value" style={{ color: 'var(--ok)' }}>
                {completionRate.toFixed(0)}%
              </div>
              <div className="mu-metric-hint">{completedTasks} / {totalTasks} Task</div>
            </Card>

            <Card className="mu-metric">
              <div className="mu-metric-label">镜像线程</div>
              <div className="mu-metric-value">{mirrorCount}</div>
              <div className="mu-metric-hint">临时扩容</div>
            </Card>

            <Card className="mu-metric">
              <div className="mu-metric-label">Token 消耗</div>
              <div className="mu-metric-value">
                {((usage?.totalInputTokens ?? 0) + (usage?.totalOutputTokens ?? 0)).toLocaleString()}
              </div>
              <div className="mu-metric-hint">累计 tokens</div>
            </Card>

            <Card className="mu-metric">
              <div className="mu-metric-label">累计费用</div>
              <div className="mu-metric-value">${(usage?.totalCostUSD ?? 0).toFixed(4)}</div>
              <div className="mu-metric-hint">API 成本</div>
            </Card>

            <Card className="mu-metric">
              <div className="mu-metric-label">成果文件</div>
              <div className="mu-metric-value">{artifacts?.length ?? 0}</div>
              <div className="mu-metric-hint">Artifacts</div>
            </Card>
          </div>

          {/* 双栏：事件流 + 状态分布 */}
          <div className="dashboard-grid" style={{ marginBottom: 'var(--space-5)' }}>
            {/* 实时事件流时间线 */}
            <Card title="实时活动流" actions={<Badge>{events?.length ?? 0}</Badge>}>
              {events === undefined ? (
                <div className="mu-skel-stack"><Skeleton lines={4} /></div>
              ) : events.length === 0 ? (
                <EmptyState icon={Icons.empty} title="暂无活动" hint="Task 创建、领取、完成等事件会实时显示在这里。" />
              ) : (
                <ul className="dashboard-timeline">
                  {events.slice(0, 12).map((e) => {
                    const meta = EVENT_META[e.kind] ?? { tone: 'var(--fg-subtle)', label: e.kind };
                    const agent = agents?.find((a) => a.id === e.assigneeAgentId);
                    return (
                      <li key={e.id} className="dashboard-timeline-item">
                        <span className="dashboard-timeline-dot" style={{ background: meta.tone }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="dashboard-timeline-head">
                            <Badge tone="neutral">{meta.label}</Badge>
                            <span className="dashboard-timeline-seq">#{e.taskSeq}</span>
                          </div>
                          <div className="dashboard-timeline-title muted">
                            {e.taskTitle}
                            {agent && <span style={{ marginLeft: 6 }}>· {agent.name}</span>}
                          </div>
                        </div>
                        <span className="dashboard-timeline-time">{relTime(e.occurredAt)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            {/* 任务状态分布 */}
            <Card title="任务状态分布" actions={<Badge>{totalTasks}</Badge>}>
              {totalTasks === 0 ? (
                <EmptyState icon={Icons.empty} title="暂无任务" hint="派发 Task 后这里会显示状态分布。" />
              ) : (
                <div className="dashboard-status-panel">
                  {/* 横向堆叠条 */}
                  <div className="dashboard-status-bar">
                    {Array.from(stateBuckets.entries()).map(([state, count]) => {
                      const meta = STATE_META[state] ?? { tone: 'var(--fg-subtle)', label: state };
                      const pct = (count / totalTasks) * 100;
                      return (
                        <div
                          key={state}
                          className="dashboard-status-seg"
                          style={{ width: `${pct}%`, background: meta.tone }}
                          title={`${meta.label}: ${count} (${pct.toFixed(0)}%)`}
                        />
                      );
                    })}
                  </div>
                  {/* 图例 */}
                  <ul className="dashboard-status-legend">
                    {Array.from(stateBuckets.entries())
                      .sort((a, b) => b[1] - a[1])
                      .map(([state, count]) => {
                        const meta = STATE_META[state] ?? { tone: 'var(--fg-subtle)', label: state };
                        const pct = (count / totalTasks) * 100;
                        return (
                          <li key={state}>
                            <span className="dashboard-status-dot" style={{ background: meta.tone }} />
                            <span>{meta.label}</span>
                            <strong>{count}</strong>
                            <span className="muted">{pct.toFixed(0)}%</span>
                          </li>
                        );
                      })}
                  </ul>
                </div>
              )}
            </Card>
          </div>

          {/* 双栏：员工负载 + 模型用量拆分 */}
          <div className="dashboard-grid">
            {/* 员工负载分布 */}
            <Card title="员工负载分布">
              {statusBoard && statusBoard.departments.length > 0 ? (
                <div className="dashboard-load-chart">
                  {statusBoard.departments.flatMap((d) => d.agents).map((a) => {
                    const max = Math.max(1, ...statusBoard.departments.flatMap((d) => d.agents.map((x) => x.queuedTaskCount)));
                    const pct = (a.queuedTaskCount / max) * 100;
                    return (
                      <div key={a.id} className="dashboard-load-row">
                        <div className="dashboard-load-label">
                          <span>{a.name}</span>
                          <span className="muted">{a.role}</span>
                        </div>
                        <div className="dashboard-load-track">
                          <div className="dashboard-load-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="dashboard-load-value">
                          {a.queuedTaskCount > 0 ? <Badge tone="warn">{a.queuedTaskCount}</Badge> : <span className="muted">0</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState icon={Icons.empty} title="暂无员工数据" hint="公司上班后员工负载会显示在这里。" />
              )}
            </Card>

            {/* Token / 费用按模型拆分 */}
            <Card title="用量按模型拆分">
              {modelEntries.length > 0 ? (
                <div className="dashboard-model-list">
                  {modelEntries.map(([model, data]) => {
                    const totalTokens = (usage?.totalInputTokens ?? 0) + (usage?.totalOutputTokens ?? 0);
                    const pct = totalTokens > 0 ? (data.tokens / totalTokens) * 100 : 0;
                    return (
                      <div key={model} className="dashboard-model-row">
                        <div className="dashboard-model-head">
                          <strong>{model}</strong>
                          <span className="muted">${data.costUSD.toFixed(4)}</span>
                        </div>
                        <div className="dashboard-model-track">
                          <div className="dashboard-model-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="muted dashboard-model-meta">
                          {data.tokens.toLocaleString()} tokens · {pct.toFixed(0)}%
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState icon={Icons.empty} title="暂无用量数据" hint="Task 执行产生 token 消耗后这里会按模型展示。" />
              )}
            </Card>
          </div>

          {/* 运行线程列表（保留，精简） */}
          <Card title="运行线程" className="section" actions={<Badge>{threads?.length ?? 0}</Badge>}>
            {threads && threads.length === 0 ? (
              <EmptyState icon={Icons.empty} title="无运行线程" hint="公司上班后将自动为进入项目的员工开启线程。" />
            ) : threads === undefined ? (
              <div className="mu-skel-stack"><Skeleton lines={3} /></div>
            ) : (
              <ul className="entity-list">
                {threads?.map((t) => {
                  const a = agents?.find((x) => x.id === t.agentId);
                  const isRunning = t.state === 'running';
                  return (
                    <li key={t.id}>
                      <div style={{ flex: 1 }}>
                        <strong>{a?.name ?? t.agentId}</strong>
                        <span className="muted thread-role">[{a?.role ?? '未知岗位'}]</span>
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
        </>
      )}
    </div>
  );
}
