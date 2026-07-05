/**
 * ConversationPanel · 类群聊对话窗口
 *
 PRD：与第一负责人对话、@员工、关键事件摘要、Task 卡片可点开详情。
 - 消息流（user/assistant/system/event）
 - 输入框（Enter 发送，Shift+Enter 换行）
 - @提及候选（来自 contactAllow，简化为前缀过滤）
 - event 消息以摘要 + Task 链接形式渲染
 - 自动滚到底
 */
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMessages, usePostMessage, useAgents, type ConversationMessage } from '../hooks/queries';
import { Badge } from './Badge';
import { Button } from './Button';
import { toast } from './Button';
import { EmptyState, Icons } from './EmptyState';

export interface ConversationPanelProps {
  scope: 'company' | 'project';
  scopeId: string;
  /** 用于解析 @提及候选员工的 companyId。 */
  companyId: string;
  title?: string;
}

export function ConversationPanel({ scope, scopeId, companyId, title }: ConversationPanelProps): React.ReactElement {
  const { data: messages, isLoading } = useMessages(scope, scopeId);
  const { data: agents } = useAgents(companyId);
  const post = usePostMessage(scope);
  const [text, setText] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = (): void => {
    if (!text.trim()) return;
    const mentions = extractMentions(text);
    post.mutate(
      { scopeId, content: text, mentions },
      {
        onSuccess: () => setText(''),
        onError: (e) => toast('error', (e as { message?: string }).message ?? '发送失败'),
      },
    );
  };

  const onChange = (v: string): void => {
    setText(v);
    const at = v.lastIndexOf('@');
    if (at >= 0) {
      setShowMentions(true);
      setMentionFilter(v.slice(at + 1));
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (name: string, id: string): void => {
    const at = text.lastIndexOf('@');
    const before = at >= 0 ? text.slice(0, at) : text;
    setText(`${before}@${name} `);
    setShowMentions(false);
    void id;
  };

  const mentionCandidates = (agents ?? []).filter((a) => a.name.includes(mentionFilter));

  return (
    <div className="mu-conv">
      {title && <div className="mu-conv-head">{title}</div>}
      <div className="mu-conv-stream" ref={scrollRef}>
        {isLoading && <div className="muted" style={{ padding: 16 }}>加载中…</div>}
        {messages && messages.length === 0 && (
          <EmptyState
            icon={Icons.empty}
            title="还没有对话"
            hint={`向第一负责人发消息，开始协${scope === 'company' ? '调公司' : '作项目'}。`}
          />
        )}
        {messages?.map((m) => (
          <MessageBubble key={m.id} message={m} agents={agents ?? []} />
        ))}
      </div>
      <div className="mu-conv-input-wrap">
        {showMentions && mentionCandidates.length > 0 && (
          <div className="mu-conv-mentions">
            {mentionCandidates.slice(0, 5).map((a) => (
              <button key={a.id} className="mu-conv-mention-item" onClick={() => insertMention(a.name, a.id)}>
                <strong>{a.name}</strong> <span className="muted">[{a.role}]</span>
              </button>
            ))}
          </div>
        )}
        <div className="mu-conv-input-row">
          <textarea
            className="mu-input mu-textarea"
            value={text}
            onChange={(e) => onChange(e.target.value)}
            placeholder="发消息给第一负责人…  Enter 发送，Shift+Enter 换行，@ 提及员工"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Button onClick={send} disabled={!text.trim()} loading={post.isPending}>
            发送
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message, agents }: { message: ConversationMessage; agents: { id: string; name: string; role: string }[] }): React.ReactElement {
  if (message.role === 'event') {
    return (
      <div className="mu-msg mu-msg-event">
        <span className="mu-msg-event-content">{message.content}</span>
        {message.refTaskId && (
          <Link to={`/tasks/${message.refTaskId}`} className="mu-msg-task-link">
            查看 Task →
          </Link>
        )}
      </div>
    );
  }
  const isUser = message.role === 'user';
  const authorName = isUser ? '我' : agents.find((a) => a.id === message.author)?.name ?? message.author;
  return (
    <div className={`mu-msg ${isUser ? 'mu-msg-user' : 'mu-msg-other'}`}>
      <div className="mu-msg-avatar" aria-hidden="true">{authorName.slice(0, 1)}</div>
      <div className="mu-msg-bubble">
        <div className="mu-msg-author">{authorName}</div>
        <div className="mu-msg-text">{message.content}</div>
      </div>
    </div>
  );
}

function extractMentions(text: string): string[] {
  const matches = text.match(/@([^\s@]+)/g) ?? [];
  return matches.map((m) => m.slice(1));
}
