/**
 * 右栏预览容器（批次 F.3 → 2026-08-27 P2 重构）。
 *
 * 独立区块版 InspectorPreviewHost 已退役——预览改为右栏统一标签的一类（InspectorTabsHost 的
 * DocTabBody）。本模块保留类型分派与安全端点加载：PreviewBody 供标签体与放大 Modal 复用。
 * 类型分派：图片/音视频/PDF/HTML 走 /artifacts/preview 安全端点（双校验 + HTML CSP），
 * Markdown/文本走 /artifacts/content 端点。HTML 加 sandbox 双保险（服务端 CSP 已禁脚本）。
 */
import type React from 'react';
import { useArtifactContent } from '../../hooks/queries';
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

export function PreviewBody({ projectId, relPath, tall }: { projectId: string; relPath: string; tall?: boolean }): React.ReactElement {
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
