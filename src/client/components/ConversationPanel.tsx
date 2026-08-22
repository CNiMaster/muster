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
import { useMessages, usePostMessage, useAgents, useCentralAgents, useTaskOnce, useTaskAction, materialRawUrl, type ConversationMessage } from '../hooks/queries';
import { onStreamDelta } from '../realtime';
import { Badge } from './Badge';
import { Button } from './Button';
import { toast } from './Button';
import { EmptyState, Icons } from './EmptyState';
import { AutoContinueCountdown } from './project/AutoContinueCountdown';
import { RoundChangesCard } from './workbench/RoundChangesCard';
import { MarkdownPreview } from './MarkdownPreview';

export interface ConversationPanelProps {
  scope: 'company' | 'project';
  scopeId: string;
  title?: string;
  /** 固定联系人；设置后成为该智能体的项目单聊，并只显示与其关联的消息。 */
  recipientAgentId?: string;
  /** 对话生成的工作单必须归入这个用户项目任务。 */
  projectTaskId?: string;
  /** 是否隐藏内部输入框（使用外部 Composer 时） */
  hideInput?: boolean;
  /** 撑满 flex 列父容器（默认固定 520px 高兜底块级父容器） */
  fill?: boolean;
  /** 批次三：随行讨论收口——把结论转成正式工作单（讨论本身不建任务不打断；由调用方决定建单方式）。 */
  onConvertToTask?: (extract: string) => void;
}

export function ConversationPanel({ scope, scopeId, title, recipientAgentId, projectTaskId, hideInput = false, fill = false, onConvertToTask }: ConversationPanelProps): React.ReactElement {
  const { data: messages, isLoading } = useMessages(scope, scopeId, recipientAgentId);
  const { data: agents } = useAgents();
  // B5 中央岗：@ 下拉并入六岗（hidden 不影响；用户可与中央职能直接说话）
  const { data: centralAgents } = useCentralAgents();
  const post = usePostMessage(scope, recipientAgentId);
  const [text, setText] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  // WP5 流式输出：当前对话归属内正在生成的增量文本（内存态；落库/超时/流结束清除）
  const [streamText, setStreamText] = useState<{ taskId: string; text: string } | null>(null);
  const streamStaleTimer = useRef<number | null>(null);

  const clearStream = (taskId?: string): void => {
    setStreamText((prev) => (taskId && prev && prev.taskId !== taskId ? prev : null));
  };

  useEffect(() => {
    const scopeMatch = (info: { projectId?: string; agentId?: string }): boolean => {
      if (scope !== 'company' && info.projectId !== scopeId) return false;
      // 单聊面板只看本人的流；群聊/负责人面板接受 scope 内全部任务（蜂群工蜂等并发流互不抢占）
      return recipientAgentId ? info.agentId === recipientAgentId : true;
    };
    const bumpStaleTimer = (taskId: string): void => {
      if (streamStaleTimer.current !== null) window.clearTimeout(streamStaleTimer.current);
      streamStaleTimer.current = window.setTimeout(() => clearStream(taskId), 5000);
    };
    const unsubscribe = onStreamDelta((info) => {
      if (!info.taskId || !scopeMatch(info)) return;
      if (info.ended) {
        clearStream(info.taskId);
        return;
      }
      if (!info.delta) return;
      setStreamText((prev) => {
        const base = prev && prev.taskId === info.taskId ? prev.text : '';
        // 超长截尾（保留最新 8000 字符），防止超长回复撑爆渲染
        const next = (base + info.delta).slice(-8000);
        return { taskId: info.taskId, text: next };
      });
      bumpStaleTimer(info.taskId);
    });
    return () => {
      unsubscribe();
      if (streamStaleTimer.current !== null) window.clearTimeout(streamStaleTimer.current);
    };
  }, [scope, scopeId, recipientAgentId]);

  // 该任务的回复已落库（messages 刷新出现 refTaskId 匹配的 assistant 消息）→ 立即清泡防重复显示
  useEffect(() => {
    if (!streamText) return;
    const persisted = (messages ?? []).some((m) => m.role === 'assistant' && m.refTaskId === streamText.taskId);
    if (persisted) clearStream(streamText.taskId);
  }, [messages]);

  // 批次 F.5：贴底追踪——用户上滚离底时不再强制拽回（读历史不被打断），新消息到达仅贴底态跟随
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  const handleStreamScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distance < 60);
  };

  const jumpToLatest = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setPinnedToBottom(true);
  };

  useEffect(() => {
    if (!pinnedToBottom || !scrollRef.current) return;
    // 跟随用瞬时滚动：smooth 动画途中会触发中间 scroll 事件（瞬时离底>60px），
    // 造成「回到最新」按钮闪烁与 pinned 抖动；跳转按钮保留 smooth。
    if (typeof scrollRef.current.scrollTo === 'function') {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
    } else {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamText, pinnedToBottom]);

  const send = (): void => {
    if (!text.trim()) return;
    const mentions = recipientAgentId ? [recipientAgentId] : extractMentions(text, rosterPlus);
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
  // B5：可见花名册 + 中央六岗（去重；中央岗带角色标签便于识别）
  const rosterPlus = (() => {
    const base = agents ?? [];
    const seen = new Set(base.map((a) => a.id));
    const extra = (centralAgents ?? []).filter((a) => !seen.has(a.id));
    return [...base, ...extra];
  })();
  const mentionCandidates = recipientAgentId
    ? []
    : rosterPlus.filter((a) => a.name.includes(mentionFilter) || a.role.includes(mentionFilter));

  return (
    <div className={`mu-conv${fill ? ' is-fill' : ''}`}>
      {title && <div className="mu-conv-head">{title}</div>}
      <div className="mu-conv-stream" ref={scrollRef} onScroll={handleStreamScroll}>
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
          <MessageBubble key={m.id} message={m} agents={agents ?? []} projectId={scope === 'project' ? scopeId : undefined} />
        ))}
        {streamText && streamText.text.trim().length > 0 && (
          <div className="mu-msg mu-msg-other">
            <div className="mu-msg-avatar" aria-hidden="true">✦</div>
            <div className="mu-msg-bubble">
              <div className="mu-msg-author">生成中<span className="mu-msg-mode-chip">⚡ 流式</span></div>
              <div className="mu-msg-text is-md">
                <MarkdownPreview source={streamText.text} />
                <span className="mu-stream-cursor" aria-hidden="true">▍</span>
              </div>
            </div>
          </div>
        )}
      </div>
      {/* 批次 F.5：读历史时离底悬浮「回到最新」；贴底时自动跟随不显示 */}
      {!pinnedToBottom && (
        <button type="button" className="mu-conv-jump" onClick={jumpToLatest} aria-label="回到最新消息">
          ↓ 回到最新
        </button>
      )}
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
            {onConvertToTask && (
              <Button
                variant="ghost"
                title="随行讨论收口：把输入框里的结论（或最近一条回复）转成正式工作单——讨论本身不建任务、不打断进行中的工作"
                disabled={!text.trim() && !(messages ?? []).some((m) => m.role === 'assistant')}
                onClick={() => {
                  const lastAssistant = [...(messages ?? [])].reverse().find((m) => m.role === 'assistant');
                  const extract = text.trim() || lastAssistant?.content?.slice(0, 400) || '';
                  if (!extract) return;
                  onConvertToTask(extract);
                }}
              >
                转为任务
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message, agents, projectId }: { message: ConversationMessage; agents: { id: string; name: string; role: string }[]; projectId?: string }): React.ReactElement {
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
        <div className="mu-msg-author">
          {authorName}
          {isUser && message.options?.mode && (
            <span className="mu-msg-mode-chip">{
              { plan: '🗺 计划模式', 'ask-always': '🛡 每步审批', 'ask-by-rule': '📋 按规则审批', 'no-approval': '⚡ 自动执行', deny: '🔒 只读' }[message.options.mode] ?? message.options.mode
            }</span>
          )}
        </div>
        <div className={isUser ? 'mu-msg-text' : 'mu-msg-text is-md'}>
          {isUser ? message.content : <MarkdownPreview source={message.content} />}
        </div>
        {message.attachments.length > 0 && (
          <div className="mu-msg-attachments">
            {message.attachments.map((a) =>
              a.kind === 'image' ? (
                <a key={a.materialId} href={materialRawUrl(message.scopeId, a.materialId)} target="_blank" rel="noreferrer" title={`${a.name} · 点击查看大图`}>
                  <img className="mu-msg-attachment-img" src={materialRawUrl(message.scopeId, a.materialId)} alt={a.name} />
                </a>
              ) : (
                <a key={a.materialId} className="mu-msg-attachment-file" href={materialRawUrl(message.scopeId, a.materialId)} target="_blank" rel="noreferrer">
                  📄 {a.name} <small>{Math.max(1, Math.round(a.size / 1024))}KB</small>
                </a>
              ),
            )}
          </div>
        )}
        {!isUser && <WaitingQuestionReply refTaskId={message.refTaskId} />}
        {!isUser && message.role === 'assistant' && message.refTaskId && projectId && (
          <RoundChangesCard projectId={projectId} taskId={message.refTaskId} />
        )}
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
      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Link to={`/tasks/${refTaskId}`} className="mu-msg-task-link">等待你的回答 → 去回答</Link>
        <AutoContinueCountdown task={task} />
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <AutoContinueCountdown task={task} />
      </div>
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
  // B5 @负责人 关键词透传：前端不认的 token 原样上送，服务端展开为全部 lead 岗
  // （干员名各异，按名匹配永远捕不到"负责人"——透传是唯一通路）
  const LEAD_KEYWORDS = new Set(['负责人', '所有负责人']);
  const ids = matches.flatMap((match) => {
    const name = match.slice(1);
    if (LEAD_KEYWORDS.has(name)) return [name];
    return agents.filter((agent) => agent.name === name).map((agent) => agent.id);
  });
  return [...new Set(ids)];
}
