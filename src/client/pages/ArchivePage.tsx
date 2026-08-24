/**
 * 归档页（蓝图组织重构 批次2）：跨项目知识库本体。
 *
 * 归档 = 项目记忆 + 调研摘要 + 成果。归档就是归档——本页只是让散在三处的知识
 * 共用一套检索：用户在这里搜到的，和智能体干活时上下文里注入的（# 相关旧档）
 * 是同一套检索（searchArchive）。成果画廊接线工作台级聚合 API（此前无 UI 消费）。
 */
import type React from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { Input } from '../components/Form';
import { EmptyState } from '../components/EmptyState';
import { CardSkeleton } from '../components/Skeleton';
import { useArchiveSearch, useWorkbenchArtifacts, useProjectsView, useProjectTasks, useUpdateProject, useRemoveProject, useRestoreProjectTask, useDeleteProjectTaskRecord, type ProjectTaskDTO } from '../hooks/queries';
import type { Project } from '../api/types';
import { toast } from '../components/Button';

const KIND_LABELS: Record<string, string> = {
  memory: '经验',
  research: '调研',
  artifact: '成果',
};

export function ArchivePage(): React.ReactElement {
  const [tab, setTab] = useState<'search' | 'projects' | 'tasks' | 'gallery'>('search');
  const [kindFilter, setKindFilter] = useState('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [groupBy, setGroupBy] = useState<'time' | 'type' | 'project'>('time');
  useMemo(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const search = useArchiveSearch(debouncedQ);
  const gallery = useWorkbenchArtifacts(tab === 'gallery' ? groupBy : 'time');

  return (
    <div className="home">
      <header className="page-header">
        <div>
          <h1>归档</h1>
          <p className="subtitle">
            跨项目的经验、调研结论与成果，以及归档的项目与任务（可还原/可删除记录——绝不触碰你的仓库目录）。
          </p>
        </div>
      </header>

      <div className="mu-tabs" style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {([
          ['search', '归档搜索'],
          ['projects', '归档项目'],
          ['tasks', '归档任务'],
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

      {tab === 'projects' && <ArchivedProjectsSection />}
      {tab === 'tasks' && <ArchivedTasksSection />}

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
                hint="搜索会命中：旧项目的已审批记忆、项目调研摘要、成果文件路径（按来源项目标注）。"
              />
            ) : search.isLoading ? (
              <CardSkeleton />
            ) : (search.data ?? []).length === 0 ? (
              <EmptyState title="没有命中" hint="换个关键词试试；归档随项目复盘自动生长，无需手动维护。" />
            ) : (
              <ul style={{ display: 'grid', gap: 10 }}>
                {(search.data ?? []).map((hit, i) => (
                  <li
                    key={`${hit.kind}-${hit.projectId}-${i}`}
                    style={{ border: '1px solid var(--mu-border)', borderRadius: 8, padding: '10px 12px' }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
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
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
            <CardSkeleton />
          ) : (gallery.data ?? []).length === 0 ? (
            <EmptyState title="还没有成果" hint="任务发布产物后会自动进入归档。" />
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
                    <li key={art.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, flexWrap: 'wrap' }}>
                      <Badge tone="neutral">{art.kind}</Badge>
                      <span style={{ fontFamily: 'var(--mu-mono)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{art.path}</span>
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


/** 归档项目 tab：已归档项目（还原/彻底删除记录）+ 已移除区（恢复显示/删除记录）。 */
function ArchivedProjectsSection(): React.ReactElement {
  const archived = useProjectsView('archived');
  const removed = useProjectsView('removed');
  const update = useUpdateProject();
  const removeProject = useRemoveProject();

  const row = (p: Project, kind: 'archived' | 'removed'): React.ReactElement => (
    <li key={p.id} style={{ border: '1px solid var(--mu-border)', borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 650, fontSize: 13, flex: 1 }}>{p.name}</span>
      <span className="muted" style={{ fontSize: 12 }}>{kind === 'archived' ? '已归档' : '已移除（记录保留）'}</span>
      {kind === 'archived' ? (
        <button type="button" className="mu-btn mu-btn-sm" onClick={() => update.mutate({ id: p.id, state: 'active' }, { onSuccess: () => toast('success', `已还原「${p.name}」为进行中`) })}>
          ↩ 取消归档
        </button>
      ) : (
        <button
          type="button"
          className="mu-btn mu-btn-sm"
          onClick={() => update.mutate({ id: p.id, settings: { ...(p.settings ?? {}), removed: false } }, { onSuccess: () => toast('success', `「${p.name}」已恢复显示`) })}
        >
          ↩ 恢复显示
        </button>
      )}
      <button
        type="button"
        className="mu-btn mu-btn-sm"
        style={{ color: 'var(--danger, #c0392b)' }}
        onClick={() => {
          if (!window.confirm(`彻底删除「${p.name}」的平台记录？\n任务/成果登记与执行历史将一并删除且不可恢复；你的项目目录与文件不会被触碰。`)) return;
          removeProject.mutate({ id: p.id, deleteRecords: true }, { onSuccess: () => toast('success', '平台记录已删除（项目目录原样保留）') });
        }}
      >
        🗑 删除记录
      </button>
    </li>
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card className="section" title="已归档项目">
        {archived.isLoading ? <span className="muted">加载中…</span>
          : (archived.data ?? []).length === 0 ? <EmptyState title="没有已归档的项目" hint="在项目卡片的三点菜单里选「归档项目」会出现在这里。" />
          : <ul style={{ display: 'grid', gap: 8 }}>{(archived.data ?? []).map((p) => row(p, 'archived'))}</ul>}
      </Card>
      <Card className="section" title="已移除（仅隐藏，记录保留）">
        {removed.isLoading ? <span className="muted">加载中…</span>
          : (removed.data ?? []).length === 0 ? <EmptyState title="没有已移除的项目" hint="移除项目时选「仅移除显示」的会出现在这里，可恢复或彻底删除记录。" />
          : <ul style={{ display: 'grid', gap: 8 }}>{(removed.data ?? []).map((p) => row(p, 'removed'))}</ul>}
      </Card>
    </div>
  );
}

/** 归档任务 tab：按来源项目分组列出已归档任务（还原/删除记录——不触碰文件）。 */
function ArchivedTasksSection(): React.ReactElement {
  const archived = useProjectsView('archived');
  if (archived.isLoading) return <span className="muted">加载中…</span>;
  const projects = archived.data ?? [];
  if (projects.length === 0) return <EmptyState title="没有已归档的项目" hint="任务按来源项目归档；先在项目里归档任务或项目。" />;
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {projects.map((p) => <ArchivedProjectTasks key={p.id} project={p} />)}
    </div>
  );
}

function ArchivedProjectTasks({ project }: { project: Project }): React.ReactElement {
  const { data: tasks } = useProjectTasks(project.id);
  const restore = useRestoreProjectTask();
  const del = useDeleteProjectTaskRecord();
  const archivedTasks = (tasks ?? []).filter((t) => t.state === 'archived');
  return (
    <Card className="section" title={`${project.name} · 归档任务 (${archivedTasks.length})`}>
      {archivedTasks.length === 0 ? (
        <span className="muted" style={{ fontSize: 12 }}>该项目没有已归档的任务</span>
      ) : (
        <ul style={{ display: 'grid', gap: 6 }}>
          {archivedTasks.map((t: ProjectTaskDTO) => (
            <li key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', border: '1px solid var(--mu-border)', borderRadius: 8, padding: '6px 10px' }}>
              <span style={{ fontSize: 13, flex: 1 }}>#{t.seq} {t.title}</span>
              <button type="button" className="mu-btn mu-btn-sm" onClick={() => restore.mutate({ projectId: project.id, id: t.id }, { onSuccess: () => toast('success', '任务已还原为进行中') })}>
                ↩ 还原
              </button>
              <button
                type="button"
                className="mu-btn mu-btn-sm"
                style={{ color: 'var(--danger, #c0392b)' }}
                onClick={() => {
                  if (!window.confirm(`删除任务「${t.title}」的平台记录？不可恢复；不会触碰仓库文件。`)) return;
                  del.mutate({ projectId: project.id, id: t.id }, { onSuccess: () => toast('success', '任务记录已删除') });
                }}
              >
                🗑 删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
