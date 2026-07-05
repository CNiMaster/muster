/**
 * MarkdownPreview · 极简 Markdown 渲染（无依赖）
 *
 仅支持标题/段落/列表/代码/引用/链接/分隔线/粗体斜体。
 完整 GFM 留给后续（避免引入 marked 等增加 bundle）。
 */
import type React from 'react';

export function MarkdownPreview({ source }: { source: string }): React.ReactElement {
  return <div className="mu-md-preview">{renderBlocks(source)}</div>;
}

function renderBlocks(src: string): React.ReactNode[] {
  const lines = src.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }
    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = inline(h[2]!);
      const Tag = (`h${Math.min(level + 1, 6)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6');
      out.push(<Tag key={key++} className={`mu-md-h mu-md-h${level}`}>{text}</Tag>);
      i++;
      continue;
    }
    // 分隔线
    if (/^---+$/.test(line.trim())) {
      out.push(<hr key={key++} className="mu-md-hr" />);
      i++;
      continue;
    }
    // 引用
    if (/^>\s/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s/.test(lines[i])) {
        buf.push(lines[i]!.replace(/^>\s/, ''));
        i++;
      }
      out.push(<blockquote key={key++} className="mu-md-quote">{inline(buf.join('\n'))}</blockquote>);
      continue;
    }
    // 代码块
    if (/^```/.test(line.trim())) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!.trim())) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // skip closing ```
      out.push(<pre key={key++} className="mu-md-code"><code>{buf.join('\n')}</code></pre>);
      continue;
    }
    // 无序列表
    if (/^[-*]\s/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(<li key={items.length}>{inline(lines[i]!.replace(/^[-*]\s/, ''))}</li>);
        i++;
      }
      out.push(<ul key={key++} className="mu-md-ul">{items}</ul>);
      continue;
    }
    // 有序列表
    if (/^\d+\.\s/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(<li key={items.length}>{inline(lines[i]!.replace(/^\d+\.\s/, ''))}</li>);
        i++;
      }
      out.push(<ol key={key++} className="mu-md-ol">{items}</ol>);
      continue;
    }
    // 段落
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6})\s/.test(lines[i]!) &&
      !/^[-*]\s/.test(lines[i]!) &&
      !/^\d+\.\s/.test(lines[i]!) &&
      !/^>\s/.test(lines[i]!) &&
      !/^```/.test(lines[i]!.trim())
    ) {
      buf.push(lines[i]!);
      i++;
    }
    out.push(<p key={key++} className="mu-md-p">{inline(buf.join(' '))}</p>);
  }
  return out;
}

function inline(text: string): React.ReactNode {
  // 粗体 + 斜体 + 链接 + 行内代码
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = regex.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2] !== undefined) parts.push(<strong key={k++}>{m[2]}</strong>);
    else if (m[3] !== undefined) parts.push(<em key={k++}>{m[3]}</em>);
    else if (m[4] !== undefined) parts.push(<code key={k++} className="mu-md-icode">{m[4]}</code>);
    else if (m[5] !== undefined) parts.push(<a key={k++} href={m[6]} target="_blank" rel="noreferrer">{m[5]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
