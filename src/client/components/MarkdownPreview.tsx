/**
 * MarkdownPreview · 对话/成品共用的 Markdown 渲染（react-markdown + GFM + 代码高亮）
 *
 * 2026-08-17 升级：原无依赖极简实现替换为 react-markdown 全量 GFM（表格/删除线/任务列表）
 * + rehype-highlight 代码高亮。类名保持 .mu-md-* 兼容既有样式与消费方（ArtifactsPage/编辑器/对话气泡）。
 * 流式输出（WP5）复用本组件：节流重渲即可。
 * 批次 F.5：图片点击放大（Modal 复用）；表格横滚由 .mu-md-table-wrap 承担。
 * 批次 G.2：表格复制 TSV/下载 CSV、代码块复制、图片放大后下载。
 */
import type React from 'react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Modal } from './Modal';

/** 递归提取 React 子树的纯文本（表格/代码块导出用）。 */
function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object' && 'props' in (node as object)) {
    return nodeText((node as { props?: { children?: React.ReactNode } }).props?.children);
  }
  return '';
}

type ElementLike = { type?: unknown; props?: { children?: React.ReactNode } };

/** 从 table 子树里收集 tr 行（每行 td/th 文本，去首尾空白）。 */
function collectTableRows(node: React.ReactNode, rows: string[][]): void {
  if (Array.isArray(node)) {
    node.forEach((n) => collectTableRows(n, rows));
    return;
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) return;
  const el = node as ElementLike;
  if (el.type === 'tr') {
    const cells: string[] = [];
    const walkCells = (n: React.ReactNode): void => {
      if (Array.isArray(n)) {
        n.forEach(walkCells);
        return;
      }
      if (typeof n !== 'object' || n === null || !('props' in n)) return;
      const cell = n as ElementLike;
      if (cell.type === 'td' || cell.type === 'th') {
        cells.push(nodeText(cell.props?.children).trim());
        return;
      }
      walkCells(cell.props?.children);
    };
    walkCells(el.props?.children);
    if (cells.length > 0) rows.push(cells);
    return;
  }
  collectTableRows(el.props?.children, rows);
}

function csvEscape(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Safari 下同步 revoke 偶发中断下载，推迟到下个宏任务再回收
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function CopyButton({ getText, label = '复制' }: { getText: () => string; label?: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="mu-md-copy-btn"
      onClick={() => {
        void navigator.clipboard?.writeText(getText()).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => {
          // 剪贴板权限被拒时静默（按钮态不变化即可感知失败）
        });
      }}
    >
      {copied ? '✓ 已复制' : label}
    </button>
  );
}

function ZoomableImage({ src, alt }: { src?: string; alt?: string }): React.ReactElement {
  const [zoomed, setZoomed] = useState(false);
  const filename = src ? src.split('/').pop()?.split('?')[0] || 'image' : 'image';
  return (
    <>
      <img
        className="mu-md-img"
        src={src}
        alt={alt ?? ''}
        loading="lazy"
        style={{ cursor: 'zoom-in', maxWidth: '100%', borderRadius: 'var(--radius-sm)' }}
        onClick={() => setZoomed(true)}
      />
      {zoomed && (
        <Modal open onClose={() => setZoomed(false)} title={alt ?? '图片预览'} size="xl">
          <img src={src} alt={alt ?? ''} style={{ maxWidth: '100%', maxHeight: '72vh', display: 'block', margin: '0 auto' }} />
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <a className="mu-md-copy-btn" href={src} download={filename}>下载图片</a>
          </div>
        </Modal>
      )}
    </>
  );
}

export function MarkdownPreview({ source }: { source: string }): React.ReactElement {
  return (
    <div className="mu-md-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          h1: ({ children }) => <h2 className="mu-md-h mu-md-h1">{children}</h2>,
          h2: ({ children }) => <h2 className="mu-md-h mu-md-h2">{children}</h2>,
          h3: ({ children }) => <h3 className="mu-md-h mu-md-h3">{children}</h3>,
          h4: ({ children }) => <h4 className="mu-md-h mu-md-h3">{children}</h4>,
          h5: ({ children }) => <h5 className="mu-md-h mu-md-h3">{children}</h5>,
          h6: ({ children }) => <h6 className="mu-md-h mu-md-h3">{children}</h6>,
          p: ({ children }) => <p className="mu-md-p">{children}</p>,
          ul: ({ children }) => <ul className="mu-md-ul">{children}</ul>,
          ol: ({ children }) => <ol className="mu-md-ol">{children}</ol>,
          blockquote: ({ children }) => <blockquote className="mu-md-quote">{children}</blockquote>,
          hr: () => <hr className="mu-md-hr" />,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">{children}</a>
          ),
          pre: ({ children }) => (
            <div className="mu-md-pre-wrap">
              <pre className="mu-md-code">{children}</pre>
              <CopyButton getText={() => nodeText(children)} />
            </div>
          ),
          code: ({ className, children, ...rest }) => {
            // 块级代码：rehype-highlight 会带 language-/hljs 类；行内代码无类名走 mu-md-icode。
            const isBlock = /language-|hljs/.test(className ?? '') || String(children).includes('\n');
            return isBlock
              ? <code className={className} {...rest}>{children}</code>
              : <code className="mu-md-icode" {...rest}>{children}</code>;
          },
          table: ({ children }) => {
            const rows: string[][] = [];
            collectTableRows(children, rows);
            return (
              <div className="mu-md-table-wrap">
                {rows.length > 0 && (
                  <div className="mu-md-table-tools">
                    <CopyButton getText={() => rows.map((r) => r.join('\t')).join('\n')} label="复制表格" />
                    <button
                      type="button"
                      className="mu-md-copy-btn"
                      onClick={() => downloadTextFile(`table-${Date.now()}.csv`, rows.map((r) => r.map(csvEscape).join(',')).join('\n'), 'text/csv')}
                    >
                      下载 CSV
                    </button>
                  </div>
                )}
                <table className="mu-md-table">{children}</table>
              </div>
            );
          },
          img: ({ src, alt }) => <ZoomableImage src={typeof src === 'string' ? src : undefined} alt={typeof alt === 'string' ? alt : undefined} />,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
