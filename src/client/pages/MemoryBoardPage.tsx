/**
 * 记忆看板（capability parity 批次 D2，spec 2026-08-25-agent-host-parity-batches）。
 *
 * 定调（拍板）：不做审批队列——沉淀闭环后台自动；看板=四维筛选+查看+编辑+删除，不黑盒：
 * 每条记忆可见注入策略（personal 永远全量 / craft 按穿戴人设 / workspace+project 渐进命中）、
 * 战绩（hit/vote）、来源档案与人设。与记忆系统四维（personal/workspace/project/craft）对齐。
 */
import { useState } from 'react';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Input } from '../components/Form';
import { useMemoryBoard, useMemoryBoardAction, type MemoryBoardEntry } from '../hooks/queries';

const SCOPE_TABS: Array<{ key: string; label: string }> = [
  { key: '', label: '全部' },
  { key: 'personal', label: '用户偏好' },
  { key: 'workspace', label: '平台' },
  { key: 'project', label: '项目' },
  { key: 'craft', label: '人设手艺' },
];

function EntryCard({ entry, onAction }: { entry: MemoryBoardEntry; onAction: (a: 'lock' | 'unlock' | 'delete' | 'correct', content?: string) => void }): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);
  return (
    <Card className={`memory-entry-card state-${entry.state}`}>
      <div className="memory-entry-head">
        <Badge tone={entry.scope === 'personal' ? 'ok' : entry.scope === 'craft' ? 'info' : 'neutral'}>{entry.scope}</Badge>
        <span className="mu-tooltip" title={entry.injectPolicy.hint}>注入：{entry.injectPolicy.label}</span>
        {entry.personaKey && <Badge tone="info">人设 {entry.personaKey}</Badge>}
        {entry.state === 'locked' && <Badge tone="warn">已锁定</Badge>}
        <span className="mu-muted">出场 {entry.hitCount} 次 · 投票 {entry.voteCount}</span>
        <span className="mu-muted">{new Date(entry.updatedAt).toLocaleString()}</span>
      </div>
      {editing ? (
        <div className="memory-entry-edit">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} />
          <div className="memory-entry-actions">
            <Button size="sm" onClick={() => { onAction('correct', draft); setEditing(false); }}>保存</Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(entry.content); }}>取消</Button>
          </div>
        </div>
      ) : (
        <p className="memory-entry-content" onClick={() => setEditing(true)} title="点击编辑">{entry.content}</p>
      )}
      <div className="memory-entry-actions">
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>编辑</Button>
        {entry.state === 'locked'
          ? <Button size="sm" variant="ghost" onClick={() => onAction('unlock')}>解锁</Button>
          : <Button size="sm" variant="ghost" onClick={() => onAction('lock')}>锁定</Button>}
        <Button size="sm" variant="danger" onClick={() => onAction('delete')}>删除</Button>
      </div>
    </Card>
  );
}

export function MemoryBoardPage(): React.ReactElement {
  const [scope, setScope] = useState('');
  const [q, setQ] = useState('');
  const { data, isLoading } = useMemoryBoard({ scope: scope || undefined, q: q || undefined });
  const action = useMemoryBoardAction();

  const onAction = (a: 'lock' | 'unlock' | 'delete' | 'correct', content?: string, id?: string): void => {
    if (!id) return;
    action.mutate({ id, action: a, content }, {
      onSuccess: () => toast('success', a === 'delete' ? '已删除' : a === 'correct' ? '已修正' : '已更新'),
      onError: (e: Error) => toast('error', e.message),
    });
  };

  return (
    <div className="page memory-board-page">
      <header className="page-header">
        <h1>记忆看板</h1>
        <p className="page-subtitle">
          组织的四维记忆：用户偏好（全量注入）/平台/项目（渐进命中）/人设手艺（同款人设共享池）。
          沉淀自动进行，这里只做查看与纠偏——不做审批队列。
        </p>
      </header>
      <div className="memory-board-toolbar">
        <div className="mu-tabs">
          {SCOPE_TABS.map((t) => (
            <button key={t.key} type="button" className={`mu-tab ${scope === t.key ? 'active' : ''}`} onClick={() => setScope(t.key)}>
              {t.label}{data?.counts && t.key ? ` (${data.counts[t.key] ?? 0})` : ''}
            </button>
          ))}
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="按内容过滤…" />
      </div>
      {isLoading ? (
        <p className="mu-muted">加载中…</p>
      ) : !data || data.entries.length === 0 ? (
        <EmptyState title="暂无记忆" hint="任务完成后反思管道会自动沉淀经验；执行越多，这里越丰富。" />
      ) : (
        <div className="memory-board-list">
          {data.entries.map((e) => <EntryCard key={e.id} entry={e} onAction={(a, c) => onAction(a, c, e.id)} />)}
        </div>
      )}
    </div>
  );
}
