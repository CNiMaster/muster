/**
 * 侧边对话·右栏租户组（批次 I-b）：面板插件（I-a）之后的第二租户。
 * 折叠=最近 1 条摘要；展开=最近 3 条气泡+单行快捷输入+「展开全部 ↗」/side。
 * 组渲染条件（零消息零打扰）在 ProjectContextInspector。
 */
import { useState } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import { useSideMessages, useSendSideMessage, type SideChatMessageDTO } from '../../hooks/queries';
import { Button, toast } from '../Button';

const PREVIEW = 3;

export function SideChatPanel(): React.ReactElement {
  const { data: messages = [] } = useSideMessages();
  const send = useSendSideMessage();
  const [text, setText] = useState('');
  const recent = messages.slice(-PREVIEW);

  const handleSend = (): void => {
    const content = text.trim();
    if (!content || send.isPending) return;
    setText('');
    send.mutate(content, {
      onError: (e) => toast('error', (e as Error).message),
    });
  };

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {recent.length === 0 && (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>随手问一句（免任务）——要正式动工请到项目任务。</p>
      )}
      {recent.map((m) => (
        <Bubble key={m.id} m={m} />
      ))}
      {send.isPending && <p className="muted" style={{ fontSize: 11, margin: 0 }}>思考中…</p>}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={text}
          placeholder="问一句…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSend();
            }
          }}
          style={{ flex: 1, padding: '5px 8px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', background: 'var(--bg-elev)', fontSize: 12, fontFamily: 'inherit' }}
        />
        <Button size="sm" variant="subtle" loading={send.isPending} disabled={!text.trim()} onClick={handleSend}>问</Button>
      </div>
      <Link to="/side" style={{ fontSize: 11 }}>展开全部 ↗</Link>
    </div>
  );
}

function Bubble({ m }: { m: SideChatMessageDTO }): React.ReactElement {
  return (
    <div
      title={m.content}
      style={{
        alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
        maxWidth: '100%',
        padding: '4px 8px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-subtle)',
        background: m.role === 'user' ? 'var(--bg-elev)' : 'transparent',
        fontSize: 12,
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {m.content}
    </div>
  );
}
