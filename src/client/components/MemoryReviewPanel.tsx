import type React from 'react';
import { useState } from 'react';
import {
  useMemoryCandidates,
  useMemoryEntries,
  useMemoryEntryAction,
  useCorrectMemoryEntry,
  useReviewMemoryCandidate,
} from '../hooks/queries';
import type { MemoryCandidate } from '../api/types';
import { Badge } from './Badge';
import { Button, toast } from './Button';
import { Card } from './Card';
import { Select } from './Form';

export function MemoryReviewPanel({ profileId }: { profileId: string }): React.ReactElement {
  const { data: candidates } = useMemoryCandidates(profileId);
  const { data: entries } = useMemoryEntries(profileId);
  const review = useReviewMemoryCandidate();
  const entryAction = useMemoryEntryAction();
  const correctEntry = useCorrectMemoryEntry();
  const [scope, setScope] = useState<'all' | MemoryCandidate['scope']>('all');
  const pending = (candidates ?? []).filter((item) => item.status === 'pending' && (scope === 'all' || item.scope === scope));
  const approved = (entries ?? []).filter((item) => scope === 'all' || item.scope === scope);

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
          <option value="company">公司</option>
          <option value="project">项目</option>
          <option value="skill">Skill</option>
        </Select>
      </div>

      {pending.length > 0 && <h3 className="memory-section-title">等待你的确认</h3>}
      <div className="memory-list">
        {pending.map((candidate) => (
          <article key={candidate.id} className="memory-item">
            <div className="memory-item-main">
              <div><Badge tone={candidate.quarantineReason ? 'err' : 'info'}>{scopeLabel(candidate.scope)}</Badge></div>
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
              <div><Badge tone={entry.state === 'locked' ? 'warn' : 'ok'}>{scopeLabel(entry.scope)} · v{entry.version}</Badge></div>
              <p>{entry.content}</p>
              <details>
                <summary>版本与来源</summary>
                <p className="muted">来源候选：{entry.sourceCandidateId ?? '手动创建'} · 状态：{entry.state}</p>
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
  return ({ personal: '个人', company: '公司', project: '项目', skill: 'Skill' } as const)[scope];
}
