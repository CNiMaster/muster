/**
 * 待合并看板（批次 H·修复轮）：
 * - 系统侧：各项目任务集成分支领先状态——单合并（AI 审查流）/批量合并/丢弃（未合并提交须显式确认）。
 * - 孤儿区：git worktree list − task_runtime 登记——识别标注、清理有未合并内容防线（强制丢弃须确认）。
 * - 底部：冲突与裁决时间线（批次 I 展示层）。
 */
import type React from 'react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import {
  useProject,
  useProjectPendingMerges,
  useDiscardTaskStaging,
  useOrphanWorktrees,
  useCleanOrphanWorktrees,
  type PendingTaskMergeDTO,
  type OrphanWorktreeDTO,
  type TaskMergeResultDTO,
} from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { CardSkeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { ConflictTimelineCard } from '../components/ConflictTimelineCard';

export function ProjectMergesPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const { data: project, isLoading: isProjLoading } = useProject(projectId);
  const { data: pending = [], isLoading: isMergesLoading } = useProjectPendingMerges(projectId);
  const { data: orphans = [] } = useOrphanWorktrees(projectId);

  const discardStaging = useDiscardTaskStaging(projectId);
  const cleanOrphans = useCleanOrphanWorktrees(projectId);

  const [mergingAll, setMergingAll] = useState(false);
  const [mergingOne, setMergingOne] = useState(false);
  const [discardAsk, setDiscardAsk] = useState<PendingTaskMergeDTO | null>(null);
  const [orphanAsk, setOrphanAsk] = useState<OrphanWorktreeDTO | null>(null);

  if (isProjLoading || isMergesLoading) return <CardSkeleton />;
  void project;

  /** 单条合并：manual 首调 needsConfirm → 自动带 confirm 重试（看板口径=点击即意图明确） */
  const mergeOne = async (item: PendingTaskMergeDTO): Promise<void> => {
    setMergingOne(true);
    try {
      let r = await api.post<TaskMergeResultDTO>(`/api/projects/${projectId}/project-tasks/${item.projectTaskId}/merge`, { confirm: item.mergeMode === 'auto' });
      if (r.needsConfirm) {
        r = await api.post<TaskMergeResultDTO>(`/api/projects/${projectId}/project-tasks/${item.projectTaskId}/merge`, { confirm: true });
      }
      if (r.promoted) toast('success', `#${item.seq} 已合并：${r.summary ?? r.message}`);
      else if (r.conflicts?.length) toast('error', `#${item.seq} 冲突：${r.conflicts.slice(0, 3).join('、')}`);
      else toast('info', `#${item.seq} 本轮未合并：${r.message}`);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setMergingOne(false);
    }
  };

  const mergeAll = async (): Promise<void> => {
    if (!pending.length) return;
    setMergingAll(true);
    let ok = 0;
    for (const item of pending) {
      try {
        const r = await api.post<TaskMergeResultDTO>(`/api/projects/${projectId}/project-tasks/${item.projectTaskId}/merge`, { confirm: true });
        if (r.promoted) ok += 1;
        else if (r.conflicts?.length) toast('error', `#${item.seq} 冲突：${r.conflicts.slice(0, 3).join('、')}`);
      } catch { /* 逐项播报，失败不中断批量 */ }
    }
    setMergingAll(false);
    if (ok > 0) toast('success', `批量合并完成：${ok}/${pending.length}`);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>⬆️ 待合并任务（{pending.length}）</h3>
          {pending.length > 1 && (
            <Button size="sm" variant="ghost" loading={mergingAll} onClick={() => void mergeAll()}>批量合并全部</Button>
          )}
        </div>
        {pending.length === 0 ? (
          <EmptyState icon="✅" title="没有待合并的任务" />
        ) : (
          pending.map((item) => (
            <div key={item.projectTaskId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--border-subtle)' }}>
              <span style={{ fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                #{item.seq} {item.title}
              </span>
              <Badge tone="info">领先 {item.aheadCommits} 提交</Badge>
              {item.staleHours !== null && <Badge tone="err" title="任务集成区搁置 ≥5 小时未合并">搁置 {item.staleHours}h</Badge>}
              {item.pendingRuntimeTasks > 0 && <Badge tone="warn">{item.pendingRuntimeTasks} 在飞</Badge>}
              <Badge tone="neutral">{item.mergeMode === 'auto' ? '自动' : '手动'}</Badge>
              <Button size="sm" loading={mergingOne} onClick={() => void mergeOne(item)}>合并</Button>
              <Button size="sm" variant="ghost" onClick={() => setDiscardAsk(item)}>丢弃</Button>
            </div>
          ))
        )}
      </Card>

      <Card>
        <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>🧩 孤儿工作区（{orphans.length}）</h3>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--fg-subtle)' }}>
          未在系统登记的 worktree（用户自建或遗留）。永不自动合并、看门狗永不碰；清理有未合并内容防线。
        </p>
        {orphans.length === 0 ? (
          <EmptyState icon="🧹" title="没有孤儿工作区" />
        ) : (
          orphans.map((o) => (
            <div key={o.path} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--border-subtle)', fontSize: 12 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.path}>{o.path}</span>
              <span style={{ color: 'var(--fg-subtle)' }}>{o.branch ?? '（游离 HEAD）'}</span>
              {o.uncommittedFiles.length > 0 && <Badge tone="warn">{o.uncommittedFiles.length} 未提交</Badge>}
              {o.aheadCommits > 0 && <Badge tone="warn">{o.aheadCommits} 未合并提交</Badge>}
              {o.lastActivityAt && (Date.now() - Date.parse(o.lastActivityAt)) / 3_600_000 >= 5 && (
                <Badge tone="err" title="该工作区搁置 ≥5 小时">搁置 {Math.floor((Date.now() - Date.parse(o.lastActivityAt)) / 3_600_000)}h</Badge>
              )}
              <Button size="sm" variant="ghost" onClick={() => setOrphanAsk(o)}>清理</Button>
            </div>
          ))
        )}
      </Card>

      <ConflictTimelineCard projectId={projectId} />

      {/* 丢弃任务集成区确认（有未合并提交须显式确认——复盘 0001 防线） */}
      <Modal
        open={discardAsk !== null}
        onClose={() => setDiscardAsk(null)}
        title="丢弃任务集成区？"
        size="sm"
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setDiscardAsk(null)}>取消</Button>
            <Button
              onClick={() => {
                if (!discardAsk) return;
                discardStaging.mutate(
                  { projectTaskId: discardAsk.projectTaskId, force: true },
                  {
                    onSuccess: (r) => { toast(r.discarded ? 'success' : 'info', r.message); setDiscardAsk(null); },
                    onError: (e) => toast('error', (e as Error).message),
                  },
                );
              }}
            >
              确认丢弃
            </Button>
          </div>
        }
      >
        <p style={{ fontSize: 13, margin: 0 }}>
          「{discardAsk?.title}」集成区有 <strong>{discardAsk?.aheadCommits ?? 0}</strong> 个未合并提交，丢弃后不可找回。也可以先「合并」审阅后再决定。
        </p>
      </Modal>

      {/* 孤儿清理确认（有内容→强制丢弃；无内容→直接清） */}
      <Modal
        open={orphanAsk !== null}
        onClose={() => setOrphanAsk(null)}
        title="清理孤儿工作区"
        size="sm"
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOrphanAsk(null)}>取消</Button>
            <Button
              onClick={() => {
                if (!orphanAsk) return;
                cleanOrphans.mutate(
                  { targets: [orphanAsk.path], force: true },
                  {
                    onSuccess: (r) => {
                      if (r.blocked.length > 0) toast('error', '清理被拦：仍有未合并内容');
                      else toast('success', `已清理 ${r.cleanedCount} 个`);
                      setOrphanAsk(null);
                    },
                    onError: (e) => toast('error', (e as Error).message),
                  },
                );
              }}
            >
              {orphanAsk && (orphanAsk.uncommittedFiles.length > 0 || orphanAsk.aheadCommits > 0) ? '强制丢弃并清理' : '清理'}
            </Button>
          </div>
        }
      >
        {orphanAsk && (orphanAsk.uncommittedFiles.length > 0 || orphanAsk.aheadCommits > 0) ? (
          <div style={{ fontSize: 12 }}>
            <p style={{ color: 'var(--warn, #d97706)', marginTop: 0 }}>⚠️ 该工作区有未合并内容，默认拒绝清理。内容清单：</p>
            <pre style={{ maxHeight: '30vh', overflow: 'auto', background: 'var(--bg-elev)', padding: 8, borderRadius: 8 }}>
{[...orphanAsk.uncommittedFiles.slice(0, 20), ...(orphanAsk.aheadCommits > 0 ? [`…另有 ${orphanAsk.aheadCommits} 个未合并提交`] : [])].join('\n') || '（空）'}
            </pre>
          </div>
        ) : (
          <p style={{ fontSize: 13, margin: 0 }}>该工作区无未合并内容，可安全清理。</p>
        )}
      </Modal>
    </div>
  );
}
