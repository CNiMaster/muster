import type React from 'react';
import { Link } from 'react-router-dom';
import { useProjectConflictTimeline } from '../hooks/queries';
import { Card } from './Card';
import { Badge } from './Badge';
import { CardSkeleton } from './Skeleton';

interface Props {
  projectId: string;
}

const KIND_META: Record<string, { icon: string; tone: 'warn' | 'info' | 'ok' | 'neutral' | 'err'; label: string }> = {
  conflict_detected: { icon: '💥', tone: 'err', label: '发生冲突' },
  judge_assigned: { icon: '⚖️', tone: 'warn', label: '裁决立案' },
  debate_started: { icon: '🗣️', tone: 'info', label: '辩论协商' },
  resolved: { icon: '✅', tone: 'ok', label: '裁决收口' },
  escalated: { icon: '🚨', tone: 'err', label: '升级人工' },
  merge_pending: { icon: '⏳', tone: 'warn', label: '暂存审查' },
  merge_promoted: { icon: '🚀', tone: 'ok', label: '合入主干' },
  merge_discarded: { icon: '🗑️', tone: 'neutral', label: '放弃变更' },
};

export function ConflictTimelineCard({ projectId }: Props): React.ReactElement {
  const { data: timeline, isLoading } = useProjectConflictTimeline(projectId);

  if (isLoading) return <CardSkeleton />;
  if (!timeline || timeline.length === 0) {
    return (
      <Card title="⚖️ 冲突与裁决时间线">
        <p className="muted" style={{ margin: 0, fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
          项目暂无合并冲突或裁决事件记录，主干运行平稳。
        </p>
      </Card>
    );
  }

  return (
    <Card title="⚖️ 冲突与裁决时间线" actions={<small className="muted">共 {timeline.length} 条记录</small>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0' }}>
        {timeline.map((item, idx) => {
          const meta = KIND_META[item.kind] ?? { icon: '📌', tone: 'neutral', label: '事件' };
          return (
            <div
              key={item.id}
              style={{
                display: 'flex',
                gap: 12,
                position: 'relative',
              }}
            >
              {/* 左侧时间线图标与连线 */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 28 }}>
                <span style={{ fontSize: 18, lineHeight: 1 }}>{meta.icon}</span>
                {idx < timeline.length - 1 && (
                  <div
                    style={{
                      width: 2,
                      flex: 1,
                      background: 'var(--border)',
                      margin: '4px 0',
                    }}
                  />
                )}
              </div>

              {/* 右侧内容块 */}
              <div
                style={{
                  flex: 1,
                  background: 'var(--bg-elev)',
                  borderRadius: 8,
                  padding: '10px 14px',
                  border: '1px solid var(--border)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <strong style={{ fontSize: 14 }}>{item.title}</strong>
                    <Badge tone={meta.tone} style={{ fontSize: 10 }}>{meta.label}</Badge>
                  </div>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {new Date(item.timestamp).toLocaleString()}
                  </span>
                </div>

                <p style={{ margin: '4px 0 8px', fontSize: 13, color: 'var(--fg)' }}>
                  {item.description}
                </p>

                {item.files.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {item.files.map((file) => (
                      <span
                        key={file}
                        style={{
                          fontSize: 10,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: 'rgba(0,0,0,0.04)',
                          border: '1px solid var(--border)',
                          fontFamily: 'monospace',
                        }}
                      >
                        {file}
                      </span>
                    ))}
                  </div>
                )}

                {item.taskId && (
                  <div style={{ marginTop: 8, fontSize: 11 }}>
                    <Link to={`/tasks/${item.taskId}`} style={{ textDecoration: 'none', color: 'var(--accent)' }}>
                      查看关联任务 →
                    </Link>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
