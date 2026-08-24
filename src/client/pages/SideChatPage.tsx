/**
 * 侧边对话页（批次 I-b）：/side——免任务的快速问答。
 * 不建任务/不调工具/不进记忆；答复=负责人名义（平台 callLlm 直答）。
 * 刻意轻：单行自增高输入（Enter 发送/Shift+Enter 换行），不复用全功能 composer。
 */
import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useSideMessages, useSendSideMessage, useClearSideChat } from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Modal } from '../components/Modal';

export function SideChatPage(): React.ReactElement {
  const { data: messages = [], isLoading } = useSideMessages();
  const send = useSendSideMessage();
  const clear = useClearSideChat();
  const [text, setText] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 新消息自动滚底
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, send.isPending]);

  const handleSend = (): void => {
    const content = text.trim();
    if (!content || send.isPending) return;
    setText('');
    send.mutate(content, {
      onSuccess: (d) => {
        if (d.assistant.content.includes('侧边对话暂不可用')) toast('error', '模型未配置或调用失败——回答里附了配置指引');
      },
      onError: (e) => toast('error', (e as Error).message),
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 4px 8px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 15, flexShrink: 0 }}>💬 侧边对话</h2>
        <span className="muted" style={{ fontSize: 12, flex: '1 1 120px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>免任务快速问答 · 不进记忆 · 负责人名义值答</span>
        <Button size="sm" variant="ghost" style={{ flexShrink: 0 }} onClick={() => setConfirmClear(true)}>清空会话</Button>
      </header>

      <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 2px' }}>
        {isLoading && <p className="muted" style={{ fontSize: 12 }}>加载中…</p>}
        {!isLoading && messages.length === 0 && (
          <p className="muted" style={{ fontSize: 12 }}>随手问一句，比如「这个报错什么意思」「先给我个思路」。要正式动工请到项目任务里发起。</p>
        )}
        {messages.map((m) => (
          <div key={m.id} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '82%', padding: '8px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', background: m.role === 'user' ? 'var(--bg-elev)' : 'transparent' }}>
            {m.role === 'assistant' && <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>{m.author === 'user' ? '助手' : '负责人'}</div>}
            <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>
            <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>{new Date(m.createdAt).toLocaleTimeString()}</div>
          </div>
        ))}
        {send.isPending && <div className="muted" style={{ fontSize: 12, alignSelf: 'flex-start', padding: '4px 12px' }}>思考中…（免任务直答，最长约 1 分钟）</div>}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
        <textarea
          ref={inputRef}
          value={text}
          placeholder="问一句…（Enter 发送，Shift+Enter 换行）"
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            const el = e.target;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          style={{ flex: 1, resize: 'none', padding: '8px 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', background: 'var(--bg-elev)', fontSize: 13, fontFamily: 'inherit' }}
        />
        <Button size="sm" variant="primary" loading={send.isPending} disabled={!text.trim()} onClick={handleSend}>发送</Button>
      </div>

      <Modal open={confirmClear} onClose={() => setConfirmClear(false)} title="清空侧边会话">
        <p style={{ fontSize: 13 }}>确定清空全部侧边对话记录？此操作不可恢复。</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <Button variant="ghost" onClick={() => setConfirmClear(false)}>取消</Button>
          <Button variant="danger" onClick={() => {
            clear.mutate(undefined, {
              onSuccess: () => { setConfirmClear(false); toast('success', '已清空侧边会话'); },
              onError: (e) => toast('error', (e as Error).message),
            });
          }}>清空</Button>
        </div>
      </Modal>
    </div>
  );
}
