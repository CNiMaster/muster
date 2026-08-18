/**
 * FilesTreeModal · 项目文件目录树（只读浏览）。
 *
 * 三点菜单「查看文件/打开目录树」：懒加载（每次展开一层 depth=1），
 * 文件点击后经 artifact content 端点读文本预览；不做任何写/删。
 */
import type React from 'react';
import { useState } from 'react';
import { Modal } from '../Modal';
import { useProjectFileTree, type FileTreeNodeDTO } from '../../hooks/queries';
import { api } from '../../api/client';

function formatSize(size: number | null): string {
  if (size === null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function TreeNode({ node, projectId, depth, onPreview }: {
  node: FileTreeNodeDTO;
  projectId: string;
  depth: number;
  onPreview: (n: FileTreeNodeDTO) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(depth < 1);
  const [children, setChildren] = useState<FileTreeNodeDTO[] | null>(node.children ?? null);
  const [loading, setLoading] = useState(false);

  const toggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    // 已有子层或已到懒加载边界则直接展开
    if (next && children === null && node.kind === 'dir') {
      setLoading(true);
      api.get<FileTreeNodeDTO[]>(`/api/projects/${projectId}/files/tree?path=${encodeURIComponent(node.path)}&depth=1`)
        .then((kids) => setChildren(kids))
        .catch(() => setChildren([]))
        .finally(() => setLoading(false));
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', paddingLeft: depth * 14 }}>
        {node.kind === 'dir' ? (
          <button
            type="button"
            onClick={toggle}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: 'inherit' }}
          >
            {expanded ? '▾' : '▸'} 📁 {node.name}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onPreview(node)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: 'inherit' }}
            title={formatSize(node.size)}
          >
            📄 {node.name}
          </button>
        )}
        {loading && <span style={{ fontSize: 11, opacity: 0.6 }}>…</span>}
      </div>
      {expanded && node.kind === 'dir' && children && (
        <div>
          {children.map((c) => (
            <TreeNode key={c.path} node={c} projectId={projectId} depth={depth + 1} onPreview={onPreview} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FilesTreeModal({ projectId, projectName, open, onClose }: {
  projectId: string;
  projectName: string;
  open: boolean;
  onClose: () => void;
}): React.ReactElement {
  const { data: tree, isLoading } = useProjectFileTree(open ? projectId : undefined);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);

  const onPreview = (node: FileTreeNodeDTO): void => {
    setPreview({ name: node.name, content: '…' });
    api.get<{ content: string }>(`/api/projects/${projectId}/artifacts/content?path=${encodeURIComponent(node.path)}`)
      .then((r) => setPreview({ name: node.name, content: typeof r?.content === 'string' ? r.content : '' }))
      .catch(() => setPreview({ name: node.name, content: '（无法预览该文件）' }));
  };

  return (
    <Modal open={open} onClose={onClose} title={`📁 ${projectName} · 文件`} size="lg">
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 320px) 1fr', gap: 12, minHeight: 320, maxHeight: '60vh', overflow: 'auto' }}>
        <div style={{ borderRight: '1px solid var(--border, #eee)', paddingRight: 8, fontSize: 13 }}>
          {isLoading && <span>加载中…</span>}
          {tree?.map((n) => <TreeNode key={n.path} node={n} projectId={projectId} depth={0} onPreview={onPreview} />)}
        </div>
        <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono, monospace)', fontSize: 12, overflow: 'auto' }}>
          {preview ? `${preview.name}\n${'—'.repeat(30)}\n${preview.content}` : '点击左侧文件查看内容（只读）'}
        </div>
      </div>
    </Modal>
  );
}
