/**
 * MarkdownPreview · 对话/成品共用的 Markdown 渲染（react-markdown + GFM + 代码高亮）
 *
 * 2026-08-17 升级：原无依赖极简实现替换为 react-markdown 全量 GFM（表格/删除线/任务列表）
 * + rehype-highlight 代码高亮。类名保持 .mu-md-* 兼容既有样式与消费方（ArtifactsPage/编辑器/对话气泡）。
 * 流式输出（WP5）复用本组件：节流重渲即可。
 */
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

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
          pre: ({ children }) => <pre className="mu-md-code">{children}</pre>,
          code: ({ className, children, ...rest }) => {
            // 块级代码：rehype-highlight 会带 language-/hljs 类；行内代码无类名走 mu-md-icode。
            const isBlock = /language-|hljs/.test(className ?? '') || String(children).includes('\n');
            return isBlock
              ? <code className={className} {...rest}>{children}</code>
              : <code className="mu-md-icode" {...rest}>{children}</code>;
          },
          table: ({ children }) => (
            <div className="mu-md-table-wrap">
              <table className="mu-md-table">{children}</table>
            </div>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
