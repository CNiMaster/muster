/**
 * ConversationPanel · 类群聊对话窗口
 *
 PRD：与第一负责人对话、@智能体、关键事件摘要、Task 卡片可点开详情。
 - 消息流（user/assistant/system/event）
 - 输入框（Enter 发送，Shift+Enter 换行）
 - @提及候选（来自 contactAllow，简化为前缀过滤）
 - event 消息以摘要 + Task 链接形式渲染
 - 自动滚到底
 */
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMessages, usePostMessage, useAgents, useTaskOnce, useTaskAction, type ConversationMessage } from '../hooks/queries';
import { Badge } from './Badge';
import { Button } from './Button';
import { toast } from './Button';
import { EmptyState, Icons } from './EmptyState';

export interface ConversationPanelProps {
  scope: 'company' | 'project';
  scopeId: string;
  /** 用于解析 @提及候选智能体的 companyId。 */
  companyId: string;
  title?: string;
  /** 固定联系人；设置后成为该智能体的项目单聊，并只显示与其关联的消息。 */
  recipientAgentId?: string;
  /** 对话生成的工作单必须归入这个用户项目任务。 */
  projectTaskId?: string;
  /** 是否隐藏内部输入框（使用外部 Composer 时） */
  hideInput?: boolean;
  /** 撑满 flex 列父容器（默认固定 520px 高兜底块级父容器） */
  fill?: boolean;
}

export function ConversationPanel({ scope, scopeId, companyId, title, recipientAgentId, projectTaskId, hideInput = false, fill = false }: ConversationPanelProps): React.ReactElement {
  const { data: messages, isLoading } = useMessages(scope, scopeId, recipientAgentId);
  const { data: agents } = useAgents(companyId);
  const post = usePostMessage(scope, recipientAgentId);
  const [text, setText] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollRef.current) return;
    if (typeof scrollRef.current.scrollTo === 'function') {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    } else {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = (): void => {
    if (!text.trim()) return;
    const mentions = recipientAgentId ? [recipientAgentId] : extractMentions(text, agents ?? []);
    post.mutate(
      { scopeId, content: text, mentions, projectTaskId },
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

  const recipient = (agents ?? []).find((agent) => agent.id === recipientAgentId);
  const mentionCandidates = recipientAgentId ? [] : (agents ?? []).filter((a) => a.name.includes(mentionFilter));

  return (
    <div className={`mu-conv${fill ? ' is-fill' : ''}`}>
      {title && <div className="mu-conv-head">{title}</div>}
      <div className="mu-conv-stream" ref={scrollRef}>
        {isLoading && <div className="muted" style={{ padding: 16 }}>加载中…</div>}
        {messages && messages.length === 0 && (
          <div style={{ padding: '32px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: '12px', minHeight: '240px' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'var(--accent-subtle)', color: 'var(--accent)', display: 'grid', placeItems: 'center', fontSize: '20px' }}>
              ✨
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '480px' }}>
              <strong style={{ fontSize: '15px', color: 'var(--fg)', letterSpacing: '-0.01em' }}>
                {recipient ? `正在与 ${recipient.name} (${recipient.role}) 对话` : '与项目第一负责人协作'}
              </strong>
              <p className="muted" style={{ fontSize: '13px', margin: 0, lineHeight: 1.5 }}>
                {recipient
                  ? `向 ${recipient.name} 交代具体工作、追问执行细节或下达新任务。`
                  : '在下方直接交代目标或下达指令，系统将自动理解意图、拆解任务并调度智能体团队执行。'}
              </p>
            </div>
          </div>
        )}
        {messages?.map((m) => (
          <MessageBubble key={m.id} message={m} agents={agents ?? []} />
        ))}
      </div>
      {!hideInput && (
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
              placeholder={recipient ? `发消息给 ${recipient.name}…  Enter 发送，Shift+Enter 换行` : '发消息给第一负责人…  Enter 发送，Shift+Enter 换行，@ 提及智能体'}
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
      )}
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
        {!isUser && <WaitingQuestionReply refTaskId={message.refTaskId} />}
      </div>
    </div>
  );
}

/**
 * 指挥系统批次3：对话窗里的追问快捷回答。
 * assistant 消息带 refTaskId 且该任务仍 waiting_input 时，渲染选项按钮（或"去回答"链接），
 * 点击直接走 clarify（任务重新入队），无需跳转任务页。
 */
function WaitingQuestionReply({ refTaskId }: { refTaskId: string | null }): React.ReactElement | null {
  const { data: task } = useTaskOnce(refTaskId ?? undefined);
  const action = useTaskAction();
  if (!refTaskId || !task || task.state !== 'waiting_input') return null;
  const options = task.questionOptions ?? [];
  if (options.length === 0) {
    return (
      <div style={{ marginTop: 6 }}>
        <Link to={`/tasks/${refTaskId}`} className="mu-msg-task-link">等待你的回答 → 去回答</Link>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          className="mu-btn mu-btn-subtle mu-btn-sm"
          style={{ textAlign: 'left' }}
          disabled={action.isPending}
          onClick={() => {
            action.mutate(
              { taskId: refTaskId, action: 'clarify', payload: { optionId: option.id } },
              {
                onSuccess: () => toast('success', `已选择：${option.label}`),
                onError: (e) => toast('error', (e as Error).message ?? '回答失败'),
              },
            );
          }}
        >
          {String.fromCharCode(65 + index)}. {option.label}{option.detail ? ` — ${option.detail}` : ''}
        </button>
      ))}
    </div>
  );
}

function extractMentions(text: string, agents: Array<{ id: string; name: string }>): string[] {
  const matches = text.match(/@([^\s@]+)/g) ?? [];
  const ids = matches.flatMap((match) => {
    const name = match.slice(1);
    return agents.filter((agent) => agent.name === name).map((agent) => agent.id);
  });
  return [...new Set(ids)];
}
