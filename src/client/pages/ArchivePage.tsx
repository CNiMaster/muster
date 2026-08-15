/**
 * 归档页（蓝图组织重构 批次2）：跨项目知识库本体。
 *
 * 归档 = 项目记忆 + 调研摘要 + 成果。归档就是归档——本页只是让散在三处的知识
 * 共用一套检索：用户在这里搜到的，和智能体干活时上下文里注入的（# 相关旧档）
 * 是同一套检索（searchArchive）。成果画廊接线工作台级聚合 API（此前无 UI 消费）。
 */
import type React from 'react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { Input } from '../components/Form';
import { EmptyState } from '../components/EmptyState';
import { CardSkeleton } from '../components/Skeleton';
import { useArchiveSearch, useCompanyArtifactGallery } from '../hooks/queries';

const KIND_LABELS: Record<string, string> = {
  memory: '经验',
  research: '调研',
  artifact: '成果',
};

export function ArchivePage(): React.ReactElement {
  const { companyId } = useParams<{ companyId: string }>();
  const [tab, setTab] = useState<'search' | 'gallery'>('search');
  const [kindFilter, setKindFilter] = useState('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [groupBy, setGroupBy] = useState<'time' | 'type' | 'project'>('time');
  useMemo(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const search = useArchiveSearch(companyId, debouncedQ);
  const gallery = useCompanyArtifactGallery(companyId, tab === 'gallery' ? groupBy : 'time');

  return (
    <div className="home">
      <header className="page-header">
        <div>
          <h1>归档</h1>
          <p className="subtitle">
            跨项目的经验、调研结论与成果。智能体干活时检索注入的（# 相关旧档）就是这一套。
          </p>
        </div>
      </header>

      <div className="mu-tabs" style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {([
          ['search', '归档搜索'],
          ['gallery', '成果画廊'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`mu-tab ${tab === key ? 'mu-tab-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'search' && (
        <Card className="section">
          <Input
            placeholder="搜索所有项目的归档（经验 / 调研 / 成果路径）…"
            value={q}
            onChange={(e) => setQ((e.target as HTMLInputElement).value)}
          />
          <div style={{ marginTop: 16 }}>
            {!debouncedQ ? (
              <EmptyState
                title="输入关键词开始搜索"
                description="搜索会命中：旧项目的已审批记忆、项目调研摘要、成果文件路径（按来源项目标注）。"
              />
            ) : search.isLoading ? (
              <CardSkeleton count={3} />
            ) : (search.data ?? []).length === 0 ? (
              <EmptyState title="没有命中" description="换个关键词试试；归档随项目复盘自动生长，无需手动维护。" />
            ) : (
              <ul style={{ display: 'grid', gap: 10 }}>
                {(search.data ?? []).map((hit, i) => (
                  <li
                    key={`${hit.kind}-${hit.projectId}-${i}`}
                    style={{ border: '1px solid var(--mu-border)', borderRadius: 8, padding: '10px 12px' }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                      <Badge tone="info">{KIND_LABELS[hit.kind] ?? hit.kind}</Badge>
                      <Link to={`/projects/${hit.projectId}`} style={{ fontWeight: 600 }}>
                        {hit.projectName}
                      </Link>
                      <span style={{ color: 'var(--mu-text-tertiary)', fontSize: 12 }}>
                        {hit.createdAt.slice(0, 10)}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.6 }}>{hit.text}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      {tab === 'gallery' && (
        <Card className="section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>跨项目成果</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                className="mu-input"
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value)}
                style={{ width: 140 }}
              >
                <option value="">全部类型</option>
                {[...new Set((gallery.data ?? []).flatMap((g) => g.items.map((a) => a.kind)))].sort().map((kind) => (
                  <option key={kind} value={kind}>{kind}</option>
                ))}
              </select>
              <select
                className="mu-input"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as 'time' | 'type' | 'project')}
                style={{ width: 160 }}
              >
                <option value="time">按日期分组</option>
                <option value="type">按类型分组</option>
                <option value="project">按项目分组</option>
              </select>
            </div>
          </div>
          {gallery.isLoading ? (
            <CardSkeleton count={3} />
          ) : (gallery.data ?? []).length === 0 ? (
            <EmptyState title="还没有成果" description="任务发布产物后会自动进入归档。" />
          ) : (
            (gallery.data ?? []).map((group) => {
              const filtered = kindFilter ? group.items.filter((a) => a.kind === kindFilter) : group.items;
              if (filtered.length === 0) return null;
              return (
                <div key={group.key} style={{ marginBottom: 20 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 8 }}>
                    <span style={{ fontWeight: 600 }}>{group.label}</span>
                    <Badge>{filtered.length}</Badge>
                  </div>
                  <ul style={{ display: 'grid', gap: 6 }}>
                    {filtered.map((art) => (
                      <li key={art.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                        <Badge tone="neutral">{art.kind}</Badge>
                        <span style={{ fontFamily: 'var(--mu-mono)' }}>{art.path}</span>
                        {/* R3：来源任务维度 */}
                        {art.createdTaskId && (
                          <Link to={`/tasks/${art.createdTaskId}`} style={{ fontSize: 12 }}>来源任务</Link>
                        )}
                        <Link to={`/projects/${art.projectId}/artifacts`} style={{ marginLeft: 'auto', fontSize: 12 }}>
                          查看
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </Card>
      )}
    </div>
  );
}
