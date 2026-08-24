import type React from 'react';
import { useMemo, useState } from 'react';
import {
  useMemoryCandidates,
  useMemoryEntries,
  useMemoryEntryAction,
  useCorrectMemoryEntry,
  useProjects,
  useReviewMemoryCandidate,
} from '../hooks/queries';
import type { MemoryCandidate, MemoryEntry } from '../api/types';
import { Badge } from './Badge';
import { Button, toast } from './Button';
import { Card } from './Card';
import { Select } from './Form';

/** 经验归因徽章文案（受控四值，X3）。 */
function causeLabel(cause: string): string {
  return cause === 'model' ? '归因·模型' : cause === 'method' ? '归因·方法' : cause === 'context' ? '归因·上下文' : '归因·工具';
}

type CauseFilter = 'all' | 'model' | 'method' | 'context' | 'tool';

/** 批次 G.3：已批准记忆的多维过滤（cause/tag/项目维度）——沿用面板既有的客户端过滤模式。 */
function filterEntries(
  entries: MemoryEntry[],
  opts: { scope: 'all' | MemoryCandidate['scope']; cause: CauseFilter; tags: string[]; projectId: 'all' | string },
): MemoryEntry[] {
  return entries.filter((item) => {
    if (opts.scope !== 'all' && item.scope !== opts.scope) return false;
    if (opts.cause !== 'all' && item.cause !== opts.cause) return false;
    if (opts.projectId !== 'all' && item.projectId !== opts.projectId) return false;
    if (opts.tags.length > 0 && !opts.tags.some((t) => (item.tags ?? []).includes(t))) return false;
    return true;
  });
}

export function MemoryReviewPanel({ profileId }: { profileId: string }): React.ReactElement {
  const { data: candidates } = useMemoryCandidates(profileId);
  const { data: entries } = useMemoryEntries(profileId);
  const { data: projects } = useProjects();
  const review = useReviewMemoryCandidate();
  const entryAction = useMemoryEntryAction();
  const correctEntry = useCorrectMemoryEntry();
  const [scope, setScope] = useState<'all' | MemoryCandidate['scope']>('all');
  const [cause, setCause] = useState<CauseFilter>('all');
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState<'all' | string>('all');
  const pending = (candidates ?? []).filter((item) => item.status === 'pending' && (scope === 'all' || item.scope === scope));
  const approved = useMemo(
    () => filterEntries(entries ?? [], { scope, cause, tags: tagFilter, projectId: projectFilter }),
    [entries, scope, cause, tagFilter, projectFilter],
  );

  // 项目 id→名映射（项目维度浏览，G.3）；标签全集取自当前数据
  const projectNameById = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p.name])), [projects]);
  const distinctTags = useMemo(() => [...new Set((entries ?? []).flatMap((e) => e.tags ?? []))].sort(), [entries]);
  const projectIds = useMemo(() => [...new Set((entries ?? []).map((e) => e.projectId).filter((id): id is string => !!id))], [entries]);
  const hasDetailFilter = cause !== 'all' || tagFilter.length > 0 || projectFilter !== 'all';

  return (
    <Card title="记忆中心" className="section">
      <div className="memory-review-head">
        <div className="memory-counts">
          <Badge tone={pending.length ? 'warn' : 'neutral'}>待确认记忆 {pending.length}</Badge>
          <Badge tone="ok">已批准记忆 {approved.length}</Badge>
        </div>
        <Select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)} aria-label="记忆范围">
          <option value="all">全部范围</option>
          <option value="personal">个人</option>
          <option value="workspace">工作台</option>
          <option value="project">项目</option>
          <option value="skill">Skill</option>
        </Select>
      </div>

      <div className="memory-review-head" style={{ marginTop: 8 }}>
        <Select value={cause} onChange={(event) => setCause(event.target.value as CauseFilter)} aria-label="归因过滤">
          <option value="all">全部归因</option>
          <option value="model">归因·模型</option>
          <option value="method">归因·方法</option>
          <option value="context">归因·上下文</option>
          <option value="tool">归因·工具</option>
        </Select>
        {projectIds.length > 0 && (
          <Select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label="项目过滤">
            <option value="all">全部项目</option>
            {projectIds.map((id) => (
              <option key={id} value={id}>{projectNameById.get(id) ?? id}</option>
            ))}
          </Select>
        )}
      </div>

      {distinctTags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }} aria-label="标签过滤">
          {distinctTags.map((t) => {
            const active = tagFilter.includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTagFilter((prev) => (active ? prev.filter((x) => x !== t) : [...prev, t]))}
                style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 4, cursor: 'pointer',
                  background: active ? 'var(--accent)' : 'var(--bg-soft)',
                  color: active ? '#fff' : 'var(--fg-muted)', border: '1px solid var(--border-subtle)',
                }}
              >
                #{t}
              </button>
            );
          })}
          {hasDetailFilter && (
            <button
              type="button"
              onClick={() => { setCause('all'); setTagFilter([]); setProjectFilter('all'); }}
              style={{ fontSize: 10, padding: '1px 6px', border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer' }}
            >
              清除过滤
            </button>
          )}
        </div>
      )}

      {pending.length > 0 && <h3 className="memory-section-title">等待你的确认</h3>}
      <div className="memory-list">
        {pending.map((candidate) => (
          <article key={candidate.id} className="memory-item">
            <div className="memory-item-main">
              <div>
                <Badge tone={candidate.quarantineReason ? 'err' : 'info'}>{scopeLabel(candidate.scope)}</Badge>
                {candidate.supersedesEntryId && (
                  <Badge tone="warn" title={candidate.supersedesEntryId}>将替代 #{candidate.supersedesEntryId.slice(0, 10)}</Badge>
                )}
              </div>
              <p>{candidate.content}</p>
              {candidate.quarantineReason && <p className="error">{candidate.quarantineReason}</p>}
              <details>
                <summary>来源与影响范围</summary>
                <p className="muted diagnostic-text">
                  来源 Task：{candidate.sourceTaskId ?? '无'} · 消息：{candidate.sourceMessageId ?? '无'} ·
                  创建者：{candidate.author} · 可信度：{Math.round(candidate.confidence * 100)}% ·
                  {candidate.canInfluence ? '批准后可影响未来工作' : '仅供检索'}
                </p>
              </details>
            </div>
            <div className="memory-actions">
              <Button
                size="sm"
                aria-label="批准记忆"
                loading={review.isPending}
                onClick={() => review.mutate({ profileId, candidateId: candidate.id, action: 'approve' }, {
                  onSuccess: () => toast('success', '记忆已批准'),
                  onError: (error) => toast('error', (error as Error).message),
                })}
              >批准</Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="拒绝记忆"
                onClick={() => review.mutate({ profileId, candidateId: candidate.id, action: 'reject' })}
              >拒绝</Button>
            </div>
          </article>
        ))}
      </div>

      {approved.length > 0 && <h3 className="memory-section-title">正在使用的记忆</h3>}
      <div className="memory-list">
        {approved.map((entry) => (
          <article key={entry.id} className="memory-item">
            <div className="memory-item-main">
              <div>
                <Badge tone={entry.state === 'locked' ? 'warn' : entry.state === 'superseded' ? 'neutral' : 'ok'}>
                  {scopeLabel(entry.scope)} · v{entry.version}{entry.state === 'superseded' ? ' · 已被替代' : ''}
                </Badge>
                {entry.cause && <Badge tone="info">{causeLabel(entry.cause)}</Badge>}
                {entry.projectId && (
                  <Badge tone="neutral" title={entry.projectId}>{projectNameById.get(entry.projectId) ?? '未知项目'}</Badge>
                )}
                {(entry.tags ?? []).map((t) => (
                  <span key={t} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--bg-soft)', color: 'var(--fg-muted)', marginLeft: 4 }}>#{t}</span>
                ))}
              </div>
              <p>{entry.content}</p>
              <details>
                <summary>版本与来源</summary>
                <p className="muted">来源候选：{entry.sourceCandidateId ?? '手动创建'} · 状态：{entry.state}</p>
                {entry.hitCount !== undefined && entry.hitCount > 0 && (
                  <p className="muted">
                    注入 {entry.hitCount} 次
                    {entry.voteCount ? ` · 平均优势 ${formatAdvantage(entry.advSum ?? 0, entry.voteCount)}` : ''}
                  </p>
                )}
              </details>
            </div>
            <div className="memory-actions">
              <Button
                size="sm"
                variant="ghost"
                disabled={entry.state === 'locked'}
                onClick={() => {
                  const content = window.prompt('修正记忆内容：', entry.content);
                  if (!content?.trim() || content.trim() === entry.content) return;
                  correctEntry.mutate({ profileId, entryId: entry.id, content: content.trim() });
                }}
              >纠正</Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => entryAction.mutate({ profileId, entryId: entry.id, action: entry.state === 'locked' ? 'unlock' : 'lock' })}
              >{entry.state === 'locked' ? '解锁' : '锁定'}</Button>
              <Button
                size="sm"
                variant="danger"
                disabled={entry.state === 'locked'}
                onClick={() => entryAction.mutate({ profileId, entryId: entry.id, action: 'delete' })}
              >删除</Button>
            </div>
          </article>
        ))}
      </div>
    </Card>
  );
}

function scopeLabel(scope: MemoryCandidate['scope']): string {
  return ({ personal: '个人', workspace: '工作台', project: '项目', skill: 'Skill' } as const)[scope];
}

/** 记忆优势分展示：正数带 + 号（好于项目平均消耗），保留两位；±0.005 内四舍五入为 0.00（吞掉 -0.00）。 */
function formatAdvantage(advSum: number, votes: number): string {
  const rounded = Math.round((advSum / votes) * 100) / 100;
  if (rounded === 0) return '0.00';
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}`;
}
