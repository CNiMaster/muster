/**
 * PromptComposer · 现代自适应复合输入框组件
 *
 * 对齐 Codex / Gemini 桌面端体验：
 * - Textarea 根据内容平滑自增高（1 行 ~ 8 行自适应）
 * - 附件：+ 菜单（图片/文件）、粘贴图片、拖拽上传；以芯片形式随消息发送
 * - 任务药丸：显示/切换当前对话归属的项目任务
 * - 分支药丸：只读展示当前任务的工作分支（muster/<project>/<task> 自动管理）
 * - 底部控制栏：模型选择 / 人设药丸 / 思考深度 / 发送（Enter 发送，Shift+Enter 换行）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { Agent } from '../../api/types';
import { Button } from '../Button';
import type { MessageAttachment } from '../../hooks/queries';

export interface ComposerTaskOption {
  id: string;
  label: string;
}

export type ComposerMode = '' | 'plan' | 'ask-always' | 'ask-by-rule' | 'no-approval' | 'deny';

export const COMPOSER_MODES: Array<{ id: ComposerMode; label: string; icon: string; hint: string }> = [
  { id: '', label: '跟随默认策略', icon: '🛡', hint: '沿用任务/智能体的权限策略' },
  { id: 'plan', label: '计划模式', icon: '🗺', hint: '只调研规划不动手，产出待确认方案' },
  { id: 'ask-always', label: '每步审批', icon: '🛡', hint: '每个执行动作都要你批准' },
  { id: 'ask-by-rule', label: '按规则审批', icon: '📋', hint: '规则放行，越界才审批' },
  { id: 'no-approval', label: '自动执行', icon: '⚡', hint: '不弹审批，按范围直接执行' },
  { id: 'deny', label: '只读', icon: '🔒', hint: '拒绝一切变更动作' },
];

interface SlashCommand {
  token: string;
  label: string;
  hint: string;
  apply: () => void;
}

export interface PromptComposerProps {
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  agents?: Agent[];
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
  currentModel?: string;
  onSelectModel?: (model: string) => void;
  modelOptions?: Array<{ id: string; label: string }>;
  thinkingDepth?: 'off' | 'low' | 'med' | 'high';
  onToggleThinking?: (depth: 'off' | 'low' | 'med' | 'high') => void;
  /** 附件芯片（已上传素材引用） */
  attachments?: MessageAttachment[];
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (materialId: string) => void;
  uploading?: boolean;
  /** 附件预览/下载地址（图片芯片缩略图用） */
  attachmentUrl?: (materialId: string) => string;
  /** 任务药丸：当前任务与可切换列表 */
  taskOptions?: ComposerTaskOption[];
  selectedTaskId?: string;
  onSelectTask?: (taskId: string) => void;
  /** 分支药丸：当前任务分支（只读，自动管理） */
  branch?: string | null;
  /** 模式药丸：计划+三档审批+只读 */
  mode?: ComposerMode;
  onSelectMode?: (mode: ComposerMode) => void;
  /** 斜杠命令 /new 的落地动作（打开新建任务卡） */
  onNewTask?: () => void;
  /** 草稿持久化键（批次 G.1）：按会话隔离存 localStorage，切任务不丢未发送文本；缺省不持久化 */
  draftKey?: string;
  /** 批次 H.9：@文件 引用候选（产物/仓库相对路径，挂载方从 useArtifacts 传入） */
  fileOptions?: Array<{ path: string }>;
  /** 批次 H.5：任务运行中——发送键变方块停止键（点击打断，任务回队列让位重跑）。 */
  isRunning?: boolean;
  onStop?: () => void;
  /** 批次 H.6：划选引用（消息区选中文字→随下轮输入附上）。 */
  quotedContext?: string;
  onClearQuoted?: () => void;
  onSend: (content: string, options?: { agentId?: string; model?: string; thinking?: string; attachments?: MessageAttachment[]; mode?: ComposerMode; refs?: string[] }) => void;
}

export function PromptComposer({
  placeholder = '描述你想完成的事，或向智能体交代任务…',
  disabled = false,
  loading = false,
  agents = [],
  selectedAgentId,
  onSelectAgent,
  currentModel = '',
  onSelectModel,
  modelOptions,
  thinkingDepth = 'high',
  onToggleThinking,
  attachments = [],
  onAddFiles,
  onRemoveAttachment,
  uploading = false,
  attachmentUrl,
  taskOptions,
  selectedTaskId,
  onSelectTask,
  branch,
  mode = '',
  onSelectMode,
  onNewTask,
  draftKey,
  fileOptions = [],
  isRunning = false,
  onStop,
  quotedContext,
  onClearQuoted,
  onSend,
}: PromptComposerProps): React.ReactElement {
  // 批次 G.1：草稿按 draftKey 隔离持久化（muster:*:vN 约定）；无 key 保持纯内存行为
  const draftStorageKey = draftKey ? `muster:composer-draft:v1:${draftKey}` : null;
  const [text, setText] = useState(() => (draftStorageKey ? window.localStorage.getItem(draftStorageKey) ?? '' : ''));
  const [openMenu, setOpenMenu] = useState<'model' | 'persona' | 'task' | 'plus' | 'mode' | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  // 批次 H.9：@ 引用（员工/文件/任务三类候选；refs 上送带类型前缀 token，不动旧 mentions 语义）
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionMapRef = useRef(new Map<string, string>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const models = modelOptions ?? [];
  const currentModelLabel = models.find((m) => m.id === currentModel)?.label ?? (currentModel || '默认模型');

  // 自适应高度调整
  const adjustHeight = (): void => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(Math.max(el.scrollHeight, 42), 220);
    el.style.height = `${nextHeight}px`;
  };

  useEffect(() => {
    adjustHeight();
  }, [text]);

  // 同一挂载点切换会话（如切任务）时：先冲刷旧键未落盘文本再换装对应草稿——
  // 防抖计时器会随 key 变化被清理，不冲刷就丢"切换前最后 300ms 的输入"
  const textRef = useRef(text);
  textRef.current = text;
  const prevDraftKeyRef = useRef<string | null>(draftStorageKey);
  useEffect(() => {
    if (!draftStorageKey) {
      prevDraftKeyRef.current = null;
      return;
    }
    const prevKey = prevDraftKeyRef.current;
    if (prevKey && prevKey !== draftStorageKey && textRef.current) {
      window.localStorage.setItem(prevKey, textRef.current);
    }
    prevDraftKeyRef.current = draftStorageKey;
    setText(window.localStorage.getItem(draftStorageKey) ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftStorageKey]);

  // 输入防抖 300ms 落盘；清空即摘键，不留空串垃圾
  useEffect(() => {
    if (!draftStorageKey) return;
    const timer = window.setTimeout(() => {
      if (text) window.localStorage.setItem(draftStorageKey, text);
      else window.localStorage.removeItem(draftStorageKey);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [text, draftStorageKey]);

  // 卸载冲刷：防抖窗口内卸载（路由切换）不丢当前输入；发送清空后 text 为空串自然跳过
  const draftStateRef = useRef({ key: draftStorageKey, text });
  draftStateRef.current = { key: draftStorageKey, text };
  useEffect(() => () => {
    const { key, text: last } = draftStateRef.current;
    if (key && last) window.localStorage.setItem(key, last);
  }, []);

  // 点击外部关闭全部下拉
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionCandidates.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); insertMention(mentionCandidates[Math.min(mentionIndex, mentionCandidates.length - 1)]!); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMentionIndex(-1); return; }
    }
    if (visibleSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % visibleSlashCommands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + visibleSlashCommands.length) % visibleSlashCommands.length); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); runSlashCommand(visibleSlashCommands[Math.min(slashIndex, visibleSlashCommands.length - 1)]!); return; }
      if (e.key === 'Escape') { e.preventDefault(); setText(''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!onAddFiles) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      onAddFiles(files);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!onAddFiles) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      onAddFiles(files);
    }
    setDragOver(false);
  };

  const handleSend = (): void => {
    if ((!text.trim() && attachments.length === 0 && !quotedContext) || disabled || loading) return;
    // 批次 H.6：划选引用作为前缀随消息附上（"> 引用：…"）
    const finalText = quotedContext ? `> 引用：${quotedContext.replace(/\n+/g, ' ').slice(0, 200)}\n\n${text.trim()}` : text.trim();
    onSend(finalText, {
      agentId: selectedAgentId,
      model: currentModel || undefined,
      thinking: thinkingDepth,
      attachments: attachments.length > 0 ? attachments : undefined,
      mode: mode || undefined,
      refs: extractRefs().length > 0 ? extractRefs() : undefined,
    });
    setText('');
    if (draftStorageKey) window.localStorage.removeItem(draftStorageKey);
    if (textareaRef.current) {
      textareaRef.current.style.height = '42px';
    }
  };

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const selectedTask = taskOptions?.find((t) => t.id === selectedTaskId);

  const cycleThinking = (): void => {
    if (!onToggleThinking) return;
    const nextMap: Record<string, 'off' | 'low' | 'med' | 'high'> = {
      off: 'low',
      low: 'med',
      med: 'high',
      high: 'off',
    };
    onToggleThinking(nextMap[thinkingDepth] ?? 'high');
  };

  const slashMatch = text.match(/^\/([a-z]*)$/i);
  const slashToken = slashMatch?.[1]?.toLowerCase() ?? null;

  const slashCommands: SlashCommand[] = [
    { token: 'plan', label: '/plan 计划模式', hint: '只调研规划不动手', apply: () => onSelectMode?.('plan') },
    { token: 'ask', label: '/ask 每步审批', hint: '每个动作都要批准', apply: () => onSelectMode?.('ask-always') },
    { token: 'rules', label: '/rules 按规则审批', hint: '规则放行，越界审批', apply: () => onSelectMode?.('ask-by-rule') },
    { token: 'auto', label: '/auto 自动执行', hint: '不弹审批直接执行', apply: () => onSelectMode?.('no-approval') },
    { token: 'readonly', label: '/readonly 只读', hint: '拒绝一切变更', apply: () => onSelectMode?.('deny') },
    { token: 'default', label: '/default 跟随默认策略', hint: '回到任务默认权限', apply: () => onSelectMode?.('') },
    { token: 'model', label: '/model 切换模型', hint: '打开模型选择', apply: () => setOpenMenu('model') },
    { token: 'think', label: '/think 思考深度', hint: '切换思考档位', apply: () => cycleThinking() },
    { token: 'task', label: '/task 切换任务', hint: '打开任务选择', apply: () => setOpenMenu('task') },
    { token: 'new', label: '/new 新建任务', hint: '展开新建任务卡', apply: () => onNewTask?.() },
  ].filter((command) => onSelectMode
    || (command.token === 'model' && modelOptions && modelOptions.length > 0)
    || (command.token === 'think' && onToggleThinking)
    || (command.token === 'task' && taskOptions && taskOptions.length > 0 && onSelectTask)
    || (command.token === 'new' && onNewTask));
  const visibleSlashCommands = slashToken === null ? [] : slashCommands.filter((c) => c.token.startsWith(slashToken));

  const mentionMatch = text.match(/(?:^|\s)@([^\s@]*)$/);
  const mentionToken = mentionMatch?.[1] ?? null;
  const mentionCandidates = useMemo(() => {
    if (mentionToken === null) return [] as Array<{ display: string; token: string; group: string }>;
    const lower = mentionToken.toLowerCase();
    const list: Array<{ display: string; token: string; group: string }> = [
      ...agents.filter((a) => a.name.toLowerCase().includes(lower)).slice(0, 3)
        .map((a) => ({ display: a.name, token: `agent:${a.id}`, group: '员工' })),
      ...taskOptions?.filter((t) => t.label.toLowerCase().includes(lower)).slice(0, 3)
        .map((t) => ({ display: t.label, token: `task:${t.id}`, group: '任务' })) ?? [],
      ...fileOptions.filter((f) => f.path.toLowerCase().includes(lower)).slice(0, 4)
        .map((f) => ({ display: f.path, token: `file:${f.path}`, group: '文件' })),
    ];
    for (const c of list) mentionMapRef.current.set(c.display, c.token);
    return list.slice(0, 8);
  }, [mentionToken, agents, taskOptions, fileOptions]);
  const insertMention = (candidate: { display: string; token: string }): void => {
    setText((prev) => prev.replace(/@[^\s@]*$/, `@${candidate.display} `));
    mentionMapRef.current.set(candidate.display, candidate.token);
    setMentionIndex(0);
    textareaRef.current?.focus();
  };
  const extractRefs = (): string[] => {
    const tokens = [...text.matchAll(/@([^\s@]+)/g)].map((m) => m[1]!);
    const refs = tokens.map((t) => mentionMapRef.current.get(t)).filter((t): t is string => !!t);
    return [...new Set(refs)];
  };

  useEffect(() => {
    setSlashIndex(0);
  }, [slashToken]);

  // 评审修：mention 候选集变化时重置选中项（Escape 关闭后继续输入能重新选中第一项）
  useEffect(() => {
    setMentionIndex(0);
  }, [mentionToken]);

  const runSlashCommand = (command: SlashCommand): void => {
    command.apply();
    setText('');
    setOpenMenu(command.token === 'model' ? 'model' : command.token === 'task' ? 'task' : null);
  };

  const thinkingLabel = {
    off: '思考: 关',
    low: '思考: 快速',
    med: '思考: 中等',
    high: '思考: 深度',
  }[thinkingDepth];

  const menuButton = (menu: 'model' | 'persona' | 'task' | 'plus' | 'mode', label: React.ReactNode, title: string, extraClass = ''): React.ReactElement => (
    <button
      type="button"
      className={`mu-composer-pill ${extraClass} ${openMenu === menu ? 'is-open' : ''}`}
      onClick={() => setOpenMenu(openMenu === menu ? null : menu)}
      title={title}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={rootRef}
      className={`mu-prompt-composer ${disabled ? 'is-disabled' : ''} ${dragOver ? 'is-dragover' : ''}`}
      onDragOver={(e) => { if (onAddFiles) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* 批次 H.6：划选引用条 */}
      {quotedContext && (
        <div className="mu-composer-attachments" style={{ alignItems: 'center' }}>
          <span className="mu-composer-attachment-chip" style={{ fontStyle: 'italic' }} title={quotedContext}>
            ❝ {quotedContext.replace(/\n+/g, ' ').slice(0, 80)}{quotedContext.length > 80 ? '…' : ''}
            <button type="button" aria-label="移除引用" onClick={onClearQuoted} style={{ border: 0, background: 'none', cursor: 'pointer', padding: '0 2px' }}>×</button>
          </span>
        </div>
      )}

      {/* 附件芯片行 */}
      {(attachments.length > 0 || uploading) && (
        <div className="mu-composer-attachments">
          {attachments.map((a) => (
            <span key={a.materialId} className="mu-composer-attachment-chip" title={`${a.name} · ${Math.max(1, Math.round(a.size / 1024))}KB`}>
              {a.kind === 'image' && attachmentUrl
                ? <img src={attachmentUrl(a.materialId)} alt="" className="mu-composer-attachment-thumb" />
                : <span className="mu-composer-attachment-icon">{a.kind === 'image' ? '🖼' : '📄'}</span>}
              <span className="mu-composer-attachment-name">{a.name}</span>
              {onRemoveAttachment && (
                <button type="button" className="mu-composer-attachment-remove" aria-label={`移除附件 ${a.name}`} onClick={() => onRemoveAttachment(a.materialId)}>×</button>
              )}
            </span>
          ))}
          {uploading && <span className="mu-composer-attachment-chip is-uploading">⏳ 上传中…</span>}
        </div>
      )}

      {/* 批次 H.9：@ 引用面板（员工/文件/任务） */}
      {mentionCandidates.length > 0 && mentionIndex >= 0 && (
        <div className="mu-composer-slash">
          {mentionCandidates.map((candidate, index) => (
            <button
              key={candidate.token}
              type="button"
              className={`mu-composer-slash-item ${index === Math.min(mentionIndex, mentionCandidates.length - 1) ? 'is-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); insertMention(candidate); }}
            >
              <span>@{candidate.display}</span>
              <small>{candidate.group}</small>
            </button>
          ))}
        </div>
      )}

      {/* 斜杠命令面板：输入 / 触发 */}
      {visibleSlashCommands.length > 0 && (
        <div className="mu-composer-slash">
          {visibleSlashCommands.map((command, index) => (
            <button
              key={command.token}
              type="button"
              className={`mu-composer-slash-item ${index === Math.min(slashIndex, visibleSlashCommands.length - 1) ? 'is-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); runSlashCommand(command); }}
            >
              <span>{command.label}</span>
              <small>{command.hint}</small>
            </button>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={placeholder}
        rows={1}
        className="mu-prompt-textarea"
      />

      <div className="mu-prompt-toolbar">
        <div className="mu-prompt-controls">
          {/* 模式药丸：计划+三档审批+只读 */}
          {onSelectMode && (
            <div className="mu-composer-popover-wrap">
              {menuButton('mode', (
                <>
                  <span className="mu-pill-icon">{COMPOSER_MODES.find((m) => m.id === mode)?.icon ?? '🛡'}</span>
                  <span className="mu-pill-label">{COMPOSER_MODES.find((m) => m.id === mode)?.label ?? '模式'}</span>
                  <span className="mu-pill-arrow">▾</span>
                </>
              ), '计划模式与审批策略')}
              {openMenu === 'mode' && (
                <div className="mu-composer-dropdown">
                  <div className="mu-dropdown-header">执行模式</div>
                  {COMPOSER_MODES.map((m) => (
                    <button
                      key={m.id || 'default'}
                      type="button"
                      className={`mu-dropdown-item ${m.id === mode ? 'is-active' : ''}`}
                      onClick={() => { onSelectMode(m.id); setOpenMenu(null); }}
                    >
                      <span>{m.icon} {m.label} <small className="muted">{m.hint}</small></span>
                      {m.id === mode && <span className="mu-item-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 任务药丸 */}
          {taskOptions && taskOptions.length > 0 && onSelectTask && (
            <div className="mu-composer-popover-wrap">
              {menuButton('task', (
                <>
                  <span className="mu-pill-icon">📋</span>
                  <span className="mu-pill-label">{selectedTask ? selectedTask.label : '全局对话'}</span>
                  <span className="mu-pill-arrow">▾</span>
                </>
              ), '切换对话归属的项目任务')}
              {openMenu === 'task' && (
                <div className="mu-composer-dropdown mu-composer-dropdown-tasks">
                  <div className="mu-dropdown-header">切换任务</div>
                  {!selectedTaskId && <span className="mu-dropdown-item is-static is-active">全局对话（不归属任务）</span>}
                  {taskOptions.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`mu-dropdown-item ${t.id === selectedTaskId ? 'is-active' : ''}`}
                      onClick={() => { onSelectTask(t.id); setOpenMenu(null); }}
                    >
                      <span>{t.label}</span>
                      {t.id === selectedTaskId && <span className="mu-item-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 分支药丸（只读：任务分支自动管理） */}
          {branch && (
            <span className="mu-composer-pill mu-composer-branch" title={`本任务在独立 Git 分支上执行：${branch}。新建任务会自动创建各自的分支。`}>
              <span className="mu-pill-icon">🌿</span>
              <span className="mu-pill-label">{branch}</span>
            </span>
          )}

          {/* 模型切换下拉 */}
          {models.length > 0 && (
            <div className="mu-composer-popover-wrap">
              {menuButton('model', (
                <>
                  <span className="mu-pill-icon">🧠</span>
                  <span className="mu-pill-label">{currentModelLabel}</span>
                  <span className="mu-pill-arrow">▾</span>
                </>
              ), '切换使用的语言模型')}
              {openMenu === 'model' && (
                <div className="mu-composer-dropdown">
                  <div className="mu-dropdown-header">选择语言模型</div>
                  {models.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`mu-dropdown-item ${m.id === currentModel ? 'is-active' : ''}`}
                      onClick={() => { onSelectModel?.(m.id); setOpenMenu(null); }}
                    >
                      <span>{m.label}</span>
                      {m.id === currentModel && <span className="mu-item-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 人设选择药丸 */}
          {agents.length > 0 && (
            <div className="mu-composer-popover-wrap">
              {menuButton('persona', (
                <>
                  <span className="mu-pill-icon">🎭</span>
                  <span className="mu-pill-label">{selectedAgent ? selectedAgent.name : '智能体: 自动'}</span>
                  <span className="mu-pill-arrow">▾</span>
                </>
              ), '指定由哪位智能体处理（或自动匹配）')}
              {openMenu === 'persona' && (
                <div className="mu-composer-dropdown">
                  <div className="mu-dropdown-header">指定处理智能体</div>
                  <button
                    type="button"
                    className={`mu-dropdown-item ${!selectedAgentId ? 'is-active' : ''}`}
                    onClick={() => { onSelectAgent?.(''); setOpenMenu(null); }}
                  >
                    <span>🎯 自动匹配合适智能体</span>
                    {!selectedAgentId && <span className="mu-item-check">✓</span>}
                  </button>
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className={`mu-dropdown-item ${a.id === selectedAgentId ? 'is-active' : ''}`}
                      onClick={() => { onSelectAgent?.(a.id); setOpenMenu(null); }}
                    >
                      <span>{a.name} · <small className="muted">{a.role}</small></span>
                      {a.id === selectedAgentId && <span className="mu-item-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 思考深度切换（验收修复：简单模式 onToggleThinking 不传时隐藏——避免"点了没反应"的死药丸） */}
          {onToggleThinking && (
            <button
              type="button"
              className={`mu-composer-pill ${thinkingDepth !== 'off' ? 'is-highlight' : ''}`}
              onClick={cycleThinking}
              title="切换思考深度模式"
            >
              <span className="mu-pill-icon">💭</span>
              <span className="mu-pill-label">{thinkingLabel}</span>
            </button>
          )}

          {/* + 菜单：添加图片 / 添加文件 */}
          {onAddFiles && (
            <div className="mu-composer-popover-wrap">
              {menuButton('plus', <span className="mu-composer-icon-btn">＋</span>, '添加图片或文件附件')}
              {openMenu === 'plus' && (
                <div className="mu-composer-dropdown">
                  <div className="mu-dropdown-header">添加附件</div>
                  <button type="button" className="mu-dropdown-item" onClick={() => { imageInputRef.current?.click(); setOpenMenu(null); }}>
                    <span>🖼 添加图片</span>
                  </button>
                  <button type="button" className="mu-dropdown-item" onClick={() => { fileInputRef.current?.click(); setOpenMenu(null); }}>
                    <span>📄 添加文件</span>
                  </button>
                  <div className="mu-dropdown-hint">支持粘贴图片、拖拽文件到输入框</div>
                </div>
              )}
            </div>
          )}
          <input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) onAddFiles?.(files); e.target.value = ''; }} />
          <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) onAddFiles?.(files); e.target.value = ''; }} />
        </div>

        <div className="mu-prompt-actions">
          <span className="mu-composer-hint">Shift+Enter 换行</span>
          {isRunning && onStop && (
            <Button
              size="sm"
              variant="danger"
              onClick={onStop}
              title="打断当前执行（任务回队列让位重跑）"
              aria-label="停止当前执行"
            >
              ■
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            loading={loading}
            disabled={(!text.trim() && attachments.length === 0 && !quotedContext) || disabled}
            onClick={handleSend}
            className="mu-composer-send-btn"
          >
            <span>发送</span>
            <span aria-hidden="true">↑</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
