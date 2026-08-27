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
import { useMemoryBoard, useMemoryBoardAction, useMemoryHealth, useMemoryHousekeepingAction, type MemoryBoardEntry } from '../hooks/queries';
import { api } from '../api/client';
import { useProjects } from '../hooks/queries';

const SCOPE_TABS: Array<{ key: string; label: string }> = [
  { key: '', label: '全部' },
  { key: 'personal', label: '用户偏好' },
  { key: 'workspace', label: '平台' },
  { key: 'project', label: '项目' },
  { key: 'craft', label: '人设手艺' },
];

const SCOPE_LABEL: Record<string, string> = Object.fromEntries(
  SCOPE_TABS.filter((t) => t.key).map((t) => [t.key, t.label]),
);

/** 距今：<1min=刚刚；<24h=N 分钟/小时前；≥1 天=N 天前（与 DashboardPage 口径一致）。 */
function formatRelativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return '';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function EntryCard({ entry, flash, onAction }: { entry: MemoryBoardEntry; flash?: boolean; onAction: (a: 'lock' | 'unlock' | 'delete' | 'correct', content?: string) => void }): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);
  return (
    <Card id={`memory-entry-${entry.id}`} className={`memory-entry-card state-${entry.state}${flash ? ' is-flash' : ''}`}>
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
  const [flashId, setFlashId] = useState<string | null>(null);
  const [exportProjectId, setExportProjectId] = useState('');
  const [exporting, setExporting] = useState(false);
  const { data, isLoading } = useMemoryBoard({ scope: scope || undefined, q: q || undefined });
  const action = useMemoryBoardAction();
  const { data: healthData } = useMemoryHealth();
  const housekeeping = useMemoryHousekeepingAction();
  const { data: projects } = useProjects();
  // 列表本身已按 updatedAt 倒序（listMemoryEntries），最近变更条直接切片——筛选视图下显示筛选内的最近，口径自洽。
  const recent = data?.entries.slice(0, 6) ?? [];
  const health = healthData?.health;

  /** 选择闭环 S5：按项目导出（视图/bundle）——下载为文件；bundle 是换机/移交的快照（只含项目层）。 */
  const onExport = async (kind: 'view' | 'bundle'): Promise<void> => {
    if (!exportProjectId) return;
    setExporting(true);
    try {
      const res = await api.post<{ ok: boolean; filename: string; count: number; content?: string; bundle?: unknown }>('/api/memory-board/export', {
        projectId: exportProjectId,
        kind,
        format: 'markdown',
      });
      const text = kind === 'bundle' ? JSON.stringify(res.bundle, null, 2) : (res.content ?? '');
      const blob = new Blob([text], { type: kind === 'bundle' ? 'application/json' : 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast('success', kind === 'bundle' ? `已导出 bundle（${res.count} 条，仅项目层）` : `已导出 ${res.count} 条项目记忆`);
    } catch (e) {
      toast('error', (e as Error).message ?? '导出失败');
    } finally {
      setExporting(false);
    }
  };

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
      {recent.length > 0 && (
        <div className="memory-recent-strip" aria-label="最近变更">
          <span className="memory-recent-label">最近变更</span>
          {recent.map((e) => (
            <button
              key={e.id}
              type="button"
              className="memory-recent-chip"
              title={e.content}
              onClick={() => {
                setFlashId(e.id);
                document.getElementById(`memory-entry-${e.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                window.setTimeout(() => setFlashId((cur) => (cur === e.id ? null : cur)), 1600);
              }}
            >
              <Badge tone={e.scope === 'personal' ? 'ok' : e.scope === 'craft' ? 'info' : 'neutral'}>{SCOPE_LABEL[e.scope] ?? e.scope}</Badge>
              <span className="memory-recent-text">{e.content.length > 24 ? `${e.content.slice(0, 24)}…` : e.content}</span>
              <span className="mu-muted">{formatRelativeTime(e.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
      {health && (
        <div className="memory-health-strip" aria-label="记忆库健康度">
          <span className="memory-recent-label">健康度</span>
          <span className="mu-muted" title="active 记忆总数（含锁定）">{health.activeEntries} 条</span>
          <span className="mu-muted" title="近 7 天新增">+{health.addedLast7d}/周</span>
          <span
            className="mu-muted"
            title="同指纹重复的多余条目数（内务自动归并的原料）"
            style={{ color: health.duplicatePairs > 0 ? 'var(--warn, #b8860b)' : undefined }}
          >
            重复 {health.duplicatePairs}
          </span>
          <span
            className="mu-muted"
            title="有出场战绩的 active 记忆占比（越低说明越多记忆从未被用过）"
            style={{ color: health.hitRate !== null && health.hitRate < 0.3 ? 'var(--warn, #b8860b)' : undefined }}
          >
            命中率 {health.hitRate === null ? '—' : `${Math.round(health.hitRate * 100)}%`}
          </span>
          {health.lastCompactionAt && (
            <span className="mu-muted" title="上次内务压实">整理于 {formatRelativeTime(health.lastCompactionAt)}（归并 {health.lastCompactionMerged}）</span>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={housekeeping.isPending}
            onClick={() => housekeeping.mutate(undefined, {
              onSuccess: (res) => toast('success', res.result.merged > 0 ? `已归并 ${res.result.merged} 条重复` : '没有需要归并的重复'),
              onError: (e: Error) => toast('error', e.message),
            })}
          >
            立即整理
          </Button>
        </div>
      )}
      {(projects?.length ?? 0) > 0 && (
        <div className="memory-health-strip" aria-label="按项目导出">
          <span className="memory-recent-label">项目导出</span>
          <select value={exportProjectId} onChange={(e) => setExportProjectId(e.target.value)} className="mu-input" style={{ maxWidth: 180 }}>
            <option value="">选择项目…</option>
            {projects?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <Button size="sm" variant="ghost" disabled={!exportProjectId || exporting} onClick={() => void onExport('view')}>
            导出视图
          </Button>
          <Button size="sm" variant="ghost" disabled={!exportProjectId || exporting} onClick={() => void onExport('bundle')} title="换机/移交用快照：只含项目层记忆，不含用户偏好">
            导出 bundle
          </Button>
        </div>
      )}
      {isLoading ? (
        <p className="mu-muted">加载中…</p>
      ) : !data || data.entries.length === 0 ? (
        <EmptyState title="暂无记忆" hint="任务完成后反思管道会自动沉淀经验；执行越多，这里越丰富。" />
      ) : (
        <div className="memory-board-list">
          {data.entries.map((e) => <EntryCard key={e.id} entry={e} flash={flashId === e.id} onAction={(a, c) => onAction(a, c, e.id)} />)}
        </div>
      )}
    </div>
  );
}
