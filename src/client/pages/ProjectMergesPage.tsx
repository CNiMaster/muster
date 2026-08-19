import type React from 'react';
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  useProject,
  useProjectPendingMerges,
  usePromoteTaskMerge,
  useDiscardTaskMerge,
  useOrphanWorktrees,
  useCleanOrphanWorktrees,
  useAgents,
} from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { CardSkeleton } from '../components/Skeleton';
import { EmptyState, Icons } from '../components/EmptyState';

export function ProjectMergesPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const { data: project, isLoading: isProjLoading } = useProject(projectId);
  const { data: pendingMerges = [], isLoading: isMergesLoading } = useProjectPendingMerges(projectId);
  const { data: orphans = [], isLoading: isOrphansLoading } = useOrphanWorktrees(projectId);
  const { data: agents = [] } = useAgents();

  const promoteMutation = usePromoteTaskMerge(projectId);
  const discardMutation = useDiscardTaskMerge(projectId);
  const cleanOrphansMutation = useCleanOrphanWorktrees(projectId);

  const [mergingAll, setMergingAll] = useState(false);

  if (isProjLoading || isMergesLoading) return <CardSkeleton />;

  const handlePromote = (taskId: string, title: string) => {
    promoteMutation.mutate(taskId, {
      onSuccess: (res) => {
        if (res.promoted) toast('success', `任务「${title}」成果已合入主干`);
        else toast('error', res.message);
      },
      onError: (err) => toast('error', (err as Error).message),
    });
  };

  const handleDiscard = (taskId: string, title: string) => {
    discardMutation.mutate(taskId, {
      onSuccess: () => toast('info', `已放弃任务「${title}」变更`),
      onError: (err) => toast('error', (err as Error).message),
    });
  };

  const handlePromoteAll = async () => {
    if (!pendingMerges.length) return;
    setMergingAll(true);
    let successCount = 0;
    for (const item of pendingMerges) {
      try {
        const res = await promoteMutation.mutateAsync(item.taskId);
        if (res.promoted) successCount++;
      } catch (e) {
        toast('error', `合并「${item.title}」失败: ${(e as Error).message}`);
      }
    }
    setMergingAll(false);
    toast('success', `批量合并完成：成功合入 ${successCount} 项成果`);
  };

  const handleCleanOrphans = () => {
    cleanOrphansMutation.mutate(undefined, {
      onSuccess: (res) => toast('success', `已成功清理 ${res.cleanedCount} 个孤儿工作树`),
      onError: (err) => toast('error', (err as Error).message),
    });
  };

  return (
    <div className="project-merges-page section-stack" style={{ maxWidth: 1000, margin: '0 auto', padding: '20px' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <div className="subtitle" style={{ margin: 0 }}>
            <Link to={`/projects/${projectId}`}>← 返回项目主页</Link>
            <span style={{ margin: '0 8px' }}>·</span>
            <span className="muted">{project?.name}</span>
          </div>
          <h1 style={{ margin: '8px 0 4px', fontSize: 22 }}>🔀 待合并成果看板</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            任务级暂存工作树治理：人工审查智能体成果，一键合并或安全放弃。
          </p>
        </div>

        {pendingMerges.length > 0 && (
          <Button variant="primary" onClick={handlePromoteAll} loading={mergingAll}>
            🚀 全部一键合入 ({pendingMerges.length})
          </Button>
        )}
      </header>

      {/* 待合并列表 */}
      <section style={{ display: 'grid', gap: 16 }}>
        <h2 style={{ fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>待合并任务成果</span>
          <Badge tone={pendingMerges.length > 0 ? 'warn' : 'ok'}>{pendingMerges.length} 项待合入</Badge>
        </h2>

        {pendingMerges.length === 0 ? (
          <Card>
            <EmptyState
              icon={<span style={{ fontSize: 32 }}>✅</span>}
              title="当前暂无待合并成果"
              hint="所有任务均已自动或手动合入主干工作区。"
            />
          </Card>
        ) : (
          pendingMerges.map((item) => {
            const assignee = agents.find((a) => a.id === item.assigneeAgentId);
            return (
              <Card key={item.taskId} style={{ borderLeft: '4px solid var(--accent)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <strong style={{ fontSize: 15 }}>#{item.seq} {item.title}</strong>
                      <Badge tone="info">{assignee?.name || '智能体'}</Badge>
                      <span className="muted" style={{ fontSize: 11 }}>{new Date(item.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 12, display: 'flex', gap: 12, marginBottom: 8 }}>
                      <span>🌿 分支: <code>{item.branch}</code></span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => handlePromote(item.taskId, item.title)}
                      loading={promoteMutation.isPending}
                    >
                      🚀 合入主干
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleDiscard(item.taskId, item.title)}
                      loading={discardMutation.isPending}
                    >
                      🗑️ 放弃
                    </Button>
                  </div>
                </div>

                {item.summary && (
                  <p style={{ margin: '8px 0', fontSize: 13, background: 'var(--bg-elev)', padding: '8px 12px', borderRadius: 6 }}>
                    {item.summary}
                  </p>
                )}

                {item.artifacts.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <strong style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                      📁 产出文件 ({item.artifacts.length}):
                    </strong>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                      {item.artifacts.map((art) => (
                        <span
                          key={art.path}
                          style={{
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 4,
                            background: 'var(--bg-elev)',
                            border: '1px solid var(--border)',
                            fontFamily: 'monospace',
                          }}
                        >
                          {art.path}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            );
          })
        )}
      </section>

      {/* 孤儿工作树检测与清理 */}
      {orphans.length > 0 && (
        <section style={{ marginTop: 24, display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: 16, margin: 0, color: 'var(--warn)' }}>
              ⚠️ 检测到 {orphans.length} 个残留孤儿工作树
            </h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCleanOrphans}
              loading={cleanOrphansMutation.isPending}
            >
              🧹 一键清理孤儿工作树
            </Button>
          </div>

          <Card style={{ background: 'rgba(245, 158, 11, 0.05)', borderColor: 'var(--warn)' }}>
            <div style={{ display: 'grid', gap: 8 }}>
              {orphans.map((o) => (
                <div
                  key={o.taskId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 12,
                    padding: '6px 0',
                    borderBottom: '1px dashed rgba(245, 158, 11, 0.2)',
                  }}
                >
                  <div>
                    <code>{o.taskId}</code> · <span className="muted">{o.reason}</span>
                  </div>
                  <span className="muted">{new Date(o.mtime).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}
