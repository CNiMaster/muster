/**
 * 批次 F.3：右栏预览容器 v1。
 *
 * URL 驱动（?preview=<项目内相对路径>）——可返回/可分享；关闭即移除参数。
 * 类型分派：图片/音视频/PDF/HTML 走 /artifacts/preview 安全端点（双校验 + HTML CSP），
 * Markdown/文本走 /artifacts/content 端点。HTML 加 sandbox 双保险（服务端 CSP 已禁脚本）。
 * 放大复用 Modal（size xl）；「画廊」跳 ArtifactsPage 走完整编辑流。
 */
import { useState } from 'react';
import type React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useArtifactContent } from '../../hooks/queries';
import { Button } from '../Button';
import { Modal } from '../Modal';
import { MarkdownPreview } from '../MarkdownPreview';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const PDF_RE = /\.pdf$/i;
const VIDEO_RE = /\.(mp4|mov|avi|mkv|webm|flv)$/i;
const AUDIO_RE = /\.(mp3|wav|aac|flac|ogg|m4a)$/i;
const HTML_RE = /\.(html?|xhtml)$/i;
const MD_RE = /\.(md|markdown)$/i;

/** 预览端点 URL：路径逐段编码放 URL path（非 query），HTML 内相对资源自动解析回同端点。 */
export function artifactPreviewUrl(projectId: string, relPath: string): string {
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  return `/api/projects/${projectId}/artifacts/preview/${encoded}`;
}

function PreviewBody({ projectId, relPath, tall }: { projectId: string; relPath: string; tall?: boolean }): React.ReactElement {
  const url = artifactPreviewUrl(projectId, relPath);
  const frameStyle: React.CSSProperties = {
    width: '100%',
    height: tall ? '72vh' : 280,
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    background: '#fff',
  };
  if (IMAGE_RE.test(relPath)) {
    return <img src={url} alt={relPath} style={{ width: '100%', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }} />;
  }
  if (HTML_RE.test(relPath)) {
    return <iframe title={`预览 ${relPath}`} src={url} style={frameStyle} sandbox="" />;
  }
  if (PDF_RE.test(relPath)) {
    return <iframe title={`预览 ${relPath}`} src={url} style={frameStyle} />;
  }
  if (VIDEO_RE.test(relPath)) {
    return <video src={url} controls style={{ width: '100%', borderRadius: 'var(--radius-md)' }} />;
  }
  if (AUDIO_RE.test(relPath)) {
    return <audio src={url} controls style={{ width: '100%' }} />;
  }
  return <TextPreview projectId={projectId} relPath={relPath} tall={tall} />;
}

function TextPreview({ projectId, relPath, tall }: { projectId: string; relPath: string; tall?: boolean }): React.ReactElement {
  const { data, isLoading } = useArtifactContent(projectId, relPath);
  const scrollStyle: React.CSSProperties = { maxHeight: tall ? '72vh' : 280, overflow: 'auto' };
  if (isLoading) {
    return <p className="muted" style={{ fontSize: 12, margin: 0 }}>加载中…</p>;
  }
  const content = data?.content ?? '';
  if (MD_RE.test(relPath)) {
    return (
      <div style={{ ...scrollStyle, padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--bg-elev)' }}>
        <MarkdownPreview source={content} />
      </div>
    );
  }
  return (
    <pre className="inspector-preview-plain" style={scrollStyle}>{content}</pre>
  );
}

export function InspectorPreviewHost({ projectId }: { projectId: string }): React.ReactElement | null {
  const [searchParams, setSearchParams] = useSearchParams();
  const relPath = searchParams.get('preview');
  const [zoomed, setZoomed] = useState(false);
  if (!projectId || !relPath) return null;

  const close = (): void => {
    const next = new URLSearchParams(searchParams);
    next.delete('preview');
    setSearchParams(next);
    setZoomed(false);
  };
  const fileName = relPath.split('/').pop() ?? relPath;

  return (
    <section className="auxiliary-section inspector-preview" style={{ padding: '8px', border: '1px solid var(--accent)', borderRadius: 'var(--radius-md)', background: 'var(--bg-elev)' }}>
      <div className="auxiliary-section-title" style={{ padding: 0, marginBottom: '6px' }}>
        <span title={relPath} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>👁 {fileName}</span>
        <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <Button size="sm" variant="ghost" onClick={() => setZoomed(true)}>放大</Button>
          <Link className="mu-btn mu-btn-ghost mu-btn-sm" style={{ fontSize: 11, textDecoration: 'none' }} to={`/projects/${projectId}/artifacts?path=${encodeURIComponent(relPath)}`}>画廊</Link>
          <Button size="sm" variant="ghost" onClick={close} aria-label="关闭预览">×</Button>
        </span>
      </div>
      <PreviewBody projectId={projectId} relPath={relPath} />
      {zoomed && (
        <Modal open onClose={() => setZoomed(false)} title={fileName} size="xl">
          <PreviewBody projectId={projectId} relPath={relPath} tall />
        </Modal>
      )}
    </section>
  );
}
