/**
 * 批次 H.1：轮末变更卡——AI 整轮完成后钉在消息末尾的本轮文件变更总结。
 * 形态（用户给定验收标准）：
 * - 收起：`▸ 3个文件已更改 +28 −14 ——撤销`
 * - 展开：类型logo｜文件名｜相对地址｜+3 −3｜审查｜打开｜⌄菜单（Finder/命令行/复制相对/复制绝对路径）
 * 审查=单文件 diff；打开=右栏预览（?preview=）；撤销=revert 本轮集成分支 commit（带确认）。
 */
import { useState } from 'react';
import type React from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, toast } from '../Button';
import { Modal } from '../Modal';
import {
  useLocateRoundFile,
  useRoundChangeFile,
  useRoundChanges,
  useUndoRoundChange,
} from '../../hooks/queries';

function fileIcon(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return '🖼';
  if (['md', 'txt', 'doc', 'docx'].includes(ext)) return '📄';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java'].includes(ext)) return '⚡';
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return '🧩';
  return '📦';
}

function copyText(text: string, label: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => toast('success', `${label}已复制`),
    () => toast('error', '复制失败（剪贴板被拒）'),
  );
}

export function RoundChangesCard({ projectId, taskId }: { projectId: string; taskId: string }): React.ReactElement | null {
  const { data } = useRoundChanges(projectId, taskId);
  const undo = useUndoRoundChange(projectId);
  const [expanded, setExpanded] = useState(false);
  const [reviewPath, setReviewPath] = useState<string | undefined>();
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [menuPath, setMenuPath] = useState<string | undefined>();
  const [, setSearchParams] = useSearchParams();

  if (!data || !data.publishId || data.files.length === 0) return null;
  const adds = data.files.reduce((sum, f) => sum + (f.adds ?? 0), 0);
  const dels = data.files.reduce((sum, f) => sum + (f.dels ?? 0), 0);

  return (
    <div className="round-changes-card" style={{ marginTop: 8, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--bg-soft)', padding: '6px 10px', fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{ border: 0, background: 'none', cursor: 'pointer', color: 'var(--fg)', fontWeight: 600, padding: 0 }}
          aria-expanded={expanded}
        >
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>{' '}
          {data.rolledBack ? <s>{data.files.length} 个文件已更改</s> : `${data.files.length} 个文件已更改`} +{adds} −{dels}
        </button>
        {!data.rolledBack && (
          <button
            type="button"
            onClick={() => setConfirmUndo(true)}
            style={{ border: 0, background: 'none', cursor: 'pointer', color: 'var(--fg-muted)', marginLeft: 'auto', padding: 0 }}
            title="git revert 本轮提交（保留历史，可再撤销）"
          >
            ——撤销
          </button>
        )}
        {data.rolledBack && <span style={{ marginLeft: 'auto', color: 'var(--fg-subtle)' }}>已撤销本轮</span>}
      </div>

      {expanded && (
        <div style={{ marginTop: 4 }}>
          {data.files.map((f) => (
            <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderTop: '1px solid var(--border-subtle)' }}>
              <span aria-hidden="true">{fileIcon(f.path)}</span>
              <strong style={{ fontWeight: 600 }}>{f.path.split('/').pop()}</strong>
              <span style={{ color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' }}>{f.path}</span>
              <span style={{ color: 'var(--fg-muted)', flexShrink: 0 }}>+{f.adds ?? '−'} −{f.dels ?? '−'}</span>
              <button type="button" onClick={() => setReviewPath(f.path)} style={{ border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }}>审查</button>
              <button
                type="button"
                onClick={() => setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set('preview', f.path); return next; })}
                style={{ border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }}
              >
                打开
              </button>
              <button type="button" aria-label="更多操作" onClick={() => setMenuPath(menuPath === f.path ? undefined : f.path)} style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0 }}>⌄</button>
              {menuPath === f.path && <FileMenu projectId={projectId} taskId={taskId} path={f.path} onClose={() => setMenuPath(undefined)} />}
            </div>
          ))}
        </div>
      )}

      {confirmUndo && (
        <Modal open onClose={() => setConfirmUndo(false)} title="撤销本轮修改" size="sm">
          <p style={{ fontSize: 13 }}>将 git revert 本轮的 {data.files.length} 个文件变更（+{adds} −{dels}），生成反向提交保留历史。后续轮次的修改不受影响；若本轮之后同文件又被改过，可能产生冲突并中止。</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => setConfirmUndo(false)}>再想想</Button>
            <Button
              size="sm"
              loading={undo.isPending}
              onClick={() => undo.mutate(taskId, {
                onSuccess: () => { setConfirmUndo(false); toast('success', '本轮修改已撤销（git revert）'); },
                onError: (e) => toast('error', (e as Error).message),
              })}
            >
              确认撤销
            </Button>
          </div>
        </Modal>
      )}

      {reviewPath && <ReviewModal projectId={projectId} taskId={taskId} path={reviewPath} onClose={() => setReviewPath(undefined)} />}
    </div>
  );
}

function ReviewModal({ projectId, taskId, path, onClose }: { projectId: string; taskId: string; path: string; onClose: () => void }): React.ReactElement {
  const { data, isLoading } = useRoundChangeFile(projectId, taskId, path);
  return (
    <Modal open onClose={onClose} title={`审查：${path}`} size="xl">
      {isLoading && <p className="muted">读取 diff…</p>}
      <pre style={{ fontSize: 12, overflow: 'auto', maxHeight: '70vh', whiteSpace: 'pre-wrap' }}>{data?.diff || '（无差异文本）'}</pre>
    </Modal>
  );
}

function FileMenu({ projectId, taskId, path, onClose }: { projectId: string; taskId: string; path: string; onClose: () => void }): React.ReactElement {
  const locate = useLocateRoundFile(projectId, taskId, path);
  return (
    <div style={{ position: 'absolute', right: 0, zIndex: 20, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-2)', padding: '4px 0', fontSize: 12 }} onMouseLeave={onClose}>
      <button type="button" style={menuBtn} onClick={() => { void fetch(`/api/projects/${projectId}/artifacts/reveal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }); onClose(); }}>在 Finder 中显示</button>
      <button type="button" style={menuBtn} disabled={!locate.data} onClick={() => { if (locate.data) copyText(`cd '${locate.data.dir}'`, '终端命令'); onClose(); }}>命令行（复制 cd 命令）</button>
      <button type="button" style={menuBtn} onClick={() => { copyText(path, '相对路径'); onClose(); }}>复制相对路径</button>
      <button type="button" style={menuBtn} disabled={!locate.data} onClick={() => { if (locate.data) copyText(locate.data.abs, '绝对路径'); onClose(); }}>复制绝对路径</button>
    </div>
  );
}

const menuBtn: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', border: 0, background: 'none',
  cursor: 'pointer', padding: '6px 12px', color: 'var(--fg)', font: 'inherit', fontSize: 12,
};
