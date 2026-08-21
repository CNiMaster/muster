import type React from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input } from '../components/Form';
import { useRestoreProject, useTrash, usePurgeFromTrash, useWorkspaceAudit, type TrashItemDTO } from '../hooks/queries';

/**
 * 存储管理页（workspace 治理批次4，2026-08-21）。
 * 两块：回收站（两段式删除第二现场：恢复/彻底删除，手打确认）+ 对账（磁盘↔数据库只读清单）。
 * 文案口径：大众能懂——"彻底删除＝移入系统废纸篓（还能从废纸篓找回）"。
 */
const NO_CONFIRM_KEY = 'muster:storage:no-purge-confirm';

function sizeText(bytes: number): string {
  if (bytes < 0) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function StoragePage(): React.ReactElement {
  const { data: trash, isLoading: trashLoading } = useTrash();
  const { data: audit, isLoading: auditLoading } = useWorkspaceAudit();
  const restore = useRestoreProject();
  const purge = usePurgeFromTrash();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmText, setConfirmText] = useState('');
  const [pendingPurge, setPendingPurge] = useState<{ ids: string[]; expected: string } | null>(null);
  const [skipConfirm, setSkipConfirm] = useState(() => localStorage.getItem(NO_CONFIRM_KEY) === '1');

  const items = trash ?? [];
  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startPurge = (ids: string[], single?: TrashItemDTO): void => {
    const expected = single
      ? (single.originalRootDir.split('/').pop() ?? '')
      : `删除${ids.length}项`;
    // 「不再提醒」偏好：单个删除直接进系统废纸篓（最后安全网仍在）
    if (single && skipConfirm) {
      purge.mutate({ ids, confirm: expected }, {
        onSuccess: () => toast('success', '已移入系统废纸篓（可从废纸篓找回）'),
        onError: (e) => toast('error', (e as Error).message),
      });
      return;
    }
    setPendingPurge({ ids, expected });
    setConfirmText('');
  };

  const doPurge = (): void => {
    if (!pendingPurge) return;
    purge.mutate({ ids: pendingPurge.ids, confirm: confirmText.trim() }, {
      onSuccess: (r) => {
        toast('success', `已彻底删除 ${r.purged} 项（移入系统废纸篓，可从废纸篓找回）`);
        setPendingPurge(null);
        setSelected(new Set());
      },
      onError: (e) => toast('error', (e as Error).message),
    });
  };

  const orphanTotal = useMemo(() => (audit ? audit.projects.orphanMarked.length + audit.tasks.orphanMarked.length : 0), [audit]);

  return <div className="project-settings-page" style={{ maxWidth: 860, margin: '0 auto' }}>
    <header className="page-header">
      <div>
        <h1>存储管理</h1>
        <p className="subtitle">回收站与磁盘对账——删除永远有兜底：先入软件回收站，彻底删除也只是移入系统废纸篓。</p>
      </div>
    </header>

    <Card title={`回收站（${items.length}）`} className="section">
      {trashLoading && <p className="muted">载入中…</p>}
      {!trashLoading && items.length === 0 && <p className="muted">回收站是空的。</p>}
      {items.length > 0 && (
        <div className="form-stack">
          {items.map((item) => (
            <div key={item.projectId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <input type="checkbox" checked={selected.has(item.projectId)} onChange={() => toggle(item.projectId)} aria-label={`选择 ${item.name}`} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{item.name}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                  {sizeText(item.sizeBytes)} · 入站 {new Date(item.trashedAt).toLocaleString()} · 搁置 {item.staleDays} 天
                  {(item.pausedAutomationIds.length + item.pausedTriggerIds.length) > 0 && ` · 暂停了 ${item.pausedAutomationIds.length + item.pausedTriggerIds.length} 个自动化/定时器`}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>原位置：{item.originalRootDir}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => restore.mutate(item.projectId, {
                onSuccess: (r) => {
                  const paused = r.pausedAutomationIds.length + r.pausedTriggerIds.length;
                  toast('success', paused > 0 ? `「${item.name}」已恢复；有 ${paused} 个自动化/定时器被暂停过，请到自动化页按需重开` : `「${item.name}」已恢复`);
                },
                onError: (e) => toast('error', (e as Error).message),
              })}>恢复</Button>
              <Button size="sm" variant="ghost" onClick={() => startPurge([item.projectId], item)}>彻底删除…</Button>
            </div>
          ))}
          {selected.size > 1 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>已选 {selected.size} 项</span>
              <Button size="sm" variant="ghost" onClick={() => startPurge([...selected])}>批量彻底删除…</Button>
            </div>
          )}
          <label style={{ fontSize: 12, color: 'var(--fg-subtle)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={skipConfirm} onChange={(e) => {
              setSkipConfirm(e.target.checked);
              localStorage.setItem(NO_CONFIRM_KEY, e.target.checked ? '1' : '0');
            }} />
            彻底删除不再打字确认（仍会移入系统废纸篓，可找回）
          </label>
        </div>
      )}
    </Card>

    <Card title="磁盘对账（只读）" className="section">
      {auditLoading && <p className="muted">载入中…</p>}
      {audit && (
        <div className="form-stack">
          <p style={{ fontSize: 13, margin: 0 }}>工作区：<code style={{ fontSize: 12 }}>{audit.workspaceRoot}</code></p>
          <p style={{ fontSize: 13, margin: 0 }}>
            正常：项目 {audit.projects.okCount} · 任务 {audit.tasks.okCount}；
            孤儿目录 {orphanTotal}（软件建过但数据库已无记录——确认后可手动清理）；
            未知目录 {audit.projects.unknown.length + audit.tasks.unknown.length}（无软件标记，请人工判断，勿自动删）。
          </p>
          {orphanTotal > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 13 }}>孤儿目录清单（{orphanTotal}）</summary>
              <ul style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '6px 0' }}>
                {[...audit.projects.orphanMarked, ...audit.tasks.orphanMarked].map((e) => (
                  <li key={e.dir}>{e.dir}（{sizeText(e.sizeBytes)}）</li>
                ))}
              </ul>
            </details>
          )}
          {audit.projects.unknown.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 13 }}>未知目录清单（{audit.projects.unknown.length}）——无软件标记，删除前务必人工确认</summary>
              <ul style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '6px 0' }}>
                {audit.projects.unknown.map((e) => (
                  <li key={e.dir}>{e.dir}（{sizeText(e.sizeBytes)}）</li>
                ))}
              </ul>
            </details>
          )}
          <p style={{ fontSize: 12, color: 'var(--fg-subtle)', margin: 0 }}>清理请在 Finder 中手动进行；本页只出清单，不代删任何目录。</p>
        </div>
      )}
    </Card>

    {pendingPurge && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} role="dialog" aria-label="彻底删除确认">
        <div style={{ background: 'var(--bg-elev)', borderRadius: 12, padding: 20, width: 440, maxWidth: '90vw' }}>
          <h3 style={{ marginTop: 0 }}>彻底删除 {pendingPurge.ids.length} 项</h3>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            将把这些项目文件夹移入<strong>系统废纸篓</strong>（还能从废纸篓找回），并删除平台记录。
            为防误删，请输入 <code>{pendingPurge.expected}</code> 确认：
          </p>
          <Field label={`输入「${pendingPurge.expected}」以确认`}>
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={pendingPurge.expected} autoFocus />
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <Button variant="ghost" onClick={() => setPendingPurge(null)}>取消</Button>
            <Button onClick={doPurge} disabled={confirmText.trim() !== pendingPurge.expected} loading={purge.isPending}>彻底删除</Button>
          </div>
        </div>
      </div>
    )}

    <p style={{ fontSize: 12 }}><Link to="/settings" style={{ color: 'var(--accent)' }}>返回系统设置</Link></p>
  </div>;
}
