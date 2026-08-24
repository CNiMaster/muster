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

/**
 * 执行模式四档（2026-08-23 定案）：计划模式为默认档；用户手动切换后被记住（localStorage），
 * 下次自动恢复到上次选择，直到再次手动切换。「跟随默认档」已退役。
 * 旧值保留类型兼容（服务端归一）。
 */
export type ComposerMode = '' | 'confirm-edits' | 'auto-edit' | 'plan' | 'full-access' | 'ask-always' | 'ask-by-rule' | 'no-approval' | 'deny';

export const COMPOSER_MODES: Array<{ id: ComposerMode; label: string; short: string; icon: string; hint: string }> = [
  { id: 'plan', label: '计划模式', short: '计划', icon: '🗺', hint: '只规划不动手' },
  { id: 'auto-edit', label: '自动编辑', short: '自动', icon: '📝', hint: '改文件自动放，命令要审批' },
  { id: 'confirm-edits', label: '变更前确认', short: '确认', icon: '🛡', hint: '每个变更先问你' },
  { id: 'full-access', label: '完全访问', short: '完全', icon: '⚡', hint: '低风险自动放，越线必审' },
];

/** 固定岗编制（2026-08-24 定案）：常设四岗——负责人/人事/养蜂人/验收员；不管项目是否实例化，底部 tab 与对话人菜单都默认显示，未上岗的置灰不可选。 */
export const FIXED_AGENT_ROLES: Array<{ role: string; label: string; icon: string }> = [
  { role: 'lead', label: '负责人', icon: '🎯' },
  { role: 'hr', label: '人事', icon: '📋' },
  { role: 'swarm-dispatcher', label: '养蜂人', icon: '🐝' },
  { role: 'reviewer', label: '验收员', icon: '🔍' },
];

export function agentMatchesFixedRole(ag: Agent, role: string): boolean {
  if (role === 'reviewer') return ag.role === 'reviewer' || ag.role === 'acceptance-officer' || !!ag.isInspector;
  return ag.role === role;
}

export function isFixedRoleAgent(ag: Agent): boolean {
  return FIXED_AGENT_ROLES.some((fr) => agentMatchesFixedRole(ag, fr.role));
}

/** 固定岗中文名（对话人菜单显示；与 ProjectPage 员工标签同一套口径）。 */
export function agentRoleInfo(ag: Agent): { label: string; icon: string; order: number } {
  if (ag.role === 'lead') return { label: '负责人', icon: '🎯', order: 1 };
  if (ag.role === 'hr') return { label: '人事', icon: '📋', order: 2 };
  if (ag.role === 'swarm-dispatcher') return { label: '养蜂人', icon: '🐝', order: 3 };
  if (ag.role === 'reviewer' || ag.role === 'acceptance-officer' || ag.isInspector) return { label: '验收员', icon: '🔍', order: 4 };
  if (ag.role === 'automation-steward') return { label: '自动化管家', icon: '🤖', order: 5 };
  return { label: ag.name || '智能体', icon: '👤', order: 10 };
}

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
  /** 对话人药丸：默认负责人；切换后消息直发该人，对话区顶部显示其工作状态 */
  agents?: Agent[];
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
  /** 默认对话人（负责人）：未显式选择时药丸显示它、消息发给它 */
  defaultAgentId?: string;
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
  /** H8（第五轮定稿）：主按钮=全局暂停（本项目全部执行中任务各自等安全边界）。 */
  isRunning?: boolean;
  onStop?: () => void;
  /** H8：已请求暂停（等边界）——按钮转「暂停中…」禁用防连击。 */
  stopRequested?: boolean;
  /** H8 ⌄ 菜单：项目运行中任务数。 */
  runningCount?: number;
  /** H8 ⌄ 菜单：全局立即停止（急救：不等当前命令跑完，本项目全部执行中任务）。 */
  onStopImmediate?: () => void;
  /** 批次 H.6：划选引用（消息区选中文字→随下轮输入附上）。 */
  quotedContext?: string;
  onClearQuoted?: () => void;
  /** 2026-08-24 定案：对话人菜单顶部入口——项目群聊作为对话目标（中栏内嵌、输入框直发；再点切回单聊）。 */
  onToggleGroupChat?: () => void;
  /** 群聊激活态：菜单项高亮、药丸显示群聊。 */
  groupChatActive?: boolean;
  onSend: (content: string, options?: { agentId?: string; model?: string; thinking?: string; attachments?: MessageAttachment[]; mode?: ComposerMode; refs?: string[] }) => void;
}

export function PromptComposer({
  placeholder = '描述你想完成的事，或向智能体交代任务…',
  disabled = false,
  loading = false,
  agents = [],
  selectedAgentId,
  onSelectAgent,
  defaultAgentId,
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
  stopRequested = false,
  runningCount = 0,
  onStopImmediate,
  quotedContext,
  onClearQuoted,
  onToggleGroupChat,
  groupChatActive = false,
  onSend,
}: PromptComposerProps): React.ReactElement {
  // 批次 G.1：草稿按 draftKey 隔离持久化（muster:*:vN 约定）；无 key 保持纯内存行为
  const draftStorageKey = draftKey ? `muster:composer-draft:v1:${draftKey}` : null;
  const [text, setText] = useState(() => (draftStorageKey ? window.localStorage.getItem(draftStorageKey) ?? '' : ''));
  const [openMenu, setOpenMenu] = useState<'model' | 'persona' | 'task' | 'plus' | 'mode' | 'think' | 'send' | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // 批次 I-a2：面板插件「引用到对话」事件通道（与父控 quotedContext 合流；父控优先）
  const [panelQuote, setPanelQuote] = useState<string | undefined>();
  const [slashIndex, setSlashIndex] = useState(0);
  // 批次 H.9：@ 引用（员工/文件/任务三类候选；refs 上送带类型前缀 token，不动旧 mentions 语义）
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionMapRef = useRef(new Map<string, string>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const models = modelOptions ?? [];
  const currentModelLabel = models.find((m) => m.id === currentModel)?.label ?? (currentModel || '选择模型');

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

  // 批次 I-a2：监听面板插件标记引用事件（PanelPluginHost 派发；跨渲染树零提升接线）
  useEffect(() => {
    const onQuote = (e: Event): void => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof text === 'string' && text.trim()) setPanelQuote(text.slice(0, 2000));
    };
    window.addEventListener('muster:composer-quote', onQuote);
    return () => window.removeEventListener('muster:composer-quote', onQuote);
  }, []);

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

  // 点击收起（2026-08-23 修正）：除触发按钮与菜单本体（popover-wrap）外，点任何地方都收起——
  // 含输入框内部（原逻辑只收组件外部，点 textarea 等组件内区域菜单不收）
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest('.mu-composer-popover-wrap')) setOpenMenu(null);
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
    if ((!text.trim() && attachments.length === 0 && !quotedContext && !panelQuote) || disabled || loading) return;
    // 批次 H.6：划选引用作为前缀随消息附上（"> 引用：…"）
    const effQuote = quotedContext ?? panelQuote;
    const finalText = effQuote ? `> 引用：${effQuote.replace(/\n+/g, ' ').slice(0, 200)}\n\n${text.trim()}` : text.trim();
    onSend(finalText, {
      agentId: selectedAgentId || defaultAgentId,
      model: currentModel || undefined,
      thinking: thinkingDepth,
      attachments: attachments.length > 0 ? attachments : undefined,
      mode: mode || undefined,
      refs: extractRefs().length > 0 ? extractRefs() : undefined,
    });
    setText('');
    setPanelQuote(undefined); // 批次 I-a2：本地插件引用随发送清空
    if (draftStorageKey) window.localStorage.removeItem(draftStorageKey);
    if (textareaRef.current) {
      textareaRef.current.style.height = '42px';
    }
  };

  // 对话人：显式选择优先，否则默认负责人（2026-08-23 定案：取消「自动匹配」，对话始终有人接）
  const activeAgentId = selectedAgentId || defaultAgentId;
  const activeAgent = agents.find((a) => a.id === activeAgentId);
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
    off: '关',
    low: '快',
    med: '中',
    high: '深',
  }[thinkingDepth];

  const menuButton = (menu: 'model' | 'persona' | 'task' | 'plus' | 'mode' | 'think', label: React.ReactNode, title: string, extraClass = '', ariaLabel?: string): React.ReactElement => (
    <button
      type="button"
      className={`mu-composer-pill ${extraClass} ${openMenu === menu ? 'is-open' : ''}`}
      onClick={() => setOpenMenu(openMenu === menu ? null : menu)}
      title={title}
      aria-label={ariaLabel}
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
      {/* 批次 H.6 划选引用条 / 批次 I-a2 面板插件标记引用（合流展示，父控优先） */}
      {(quotedContext ?? panelQuote) && (
        <div className="mu-composer-attachments" style={{ alignItems: 'center' }}>
          <span className="mu-composer-attachment-chip" style={{ fontStyle: 'italic' }} title={quotedContext ?? panelQuote}>
            ❝ {(quotedContext ?? panelQuote)!.replace(/\n+/g, ' ').slice(0, 80)}{(quotedContext ?? panelQuote)!.length > 80 ? '…' : ''}
            <button type="button" aria-label="移除引用" onClick={() => { onClearQuoted?.(); setPanelQuote(undefined); }} style={{ border: 0, background: 'none', cursor: 'pointer', padding: '0 2px' }}>×</button>
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
          {/* + 菜单：添加图片 / 添加文件（2026-08-23 定案：居左首位） */}
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

          {/* 模式药丸：变更前确认那四档+跟随默认 */}
          {onSelectMode && (
            <div className="mu-composer-popover-wrap">
              {menuButton('mode', (
                <>
                  <span className="mu-pill-icon">{COMPOSER_MODES.find((m) => m.id === mode)?.icon ?? '🛡'}</span>
                  <span className="mu-pill-label">{COMPOSER_MODES.find((m) => m.id === mode)?.label ?? '模式'}</span>
                  <span className="mu-pill-arrow">▾</span>
                </>
              ), '执行模式与审批策略')}
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
                      <span className="mu-mode-item">
                        <span className="mu-mode-item-row"><span className="mu-send-menu-glyph">{m.icon}</span>{m.label}</span>
                        <small className="muted mu-mode-item-hint">{m.hint}</small>
                      </span>
                      {m.id === mode && <span className="mu-item-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 对话人药丸：默认负责人、其余固定岗；选中即直发该人并显示其工作状态 */}
          {agents.length > 0 && (
            <div className="mu-composer-popover-wrap">
              {menuButton('persona', (
                <>
                  <span className="mu-pill-icon">{groupChatActive ? '💬' : '👤'}</span>
                  <span className="mu-pill-label">{groupChatActive ? '任务群聊' : activeAgent ? activeAgent.name : '对话人'}</span>
                  <span className="mu-pill-arrow">▾</span>
                </>
              ), '切换对话人（默认负责人）', '', '切换对话人')}
              {openMenu === 'persona' && (
                <div className="mu-composer-dropdown">
                  <div className="mu-dropdown-header">对话人</div>
                  {onToggleGroupChat && (
                    <>
                      <button
                        type="button"
                        className={`mu-dropdown-item ${groupChatActive ? 'is-active' : ''}`}
                        onClick={() => { onToggleGroupChat(); setOpenMenu(null); }}
                        title="与全部固定岗群聊（可 @ 指定智能体）；再点切回当前对话人"
                      >
                        <span className="mu-mode-item-row"><span className="mu-send-menu-glyph">💬</span>任务群聊</span>
                        {groupChatActive && <span className="mu-item-check">✓</span>}
                      </button>
                      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 6px' }} />
                    </>
                  )}
                  {/* 固定岗全列（2026-08-24 定案）：在岗可选，未上岗置灰 */}
                  {FIXED_AGENT_ROLES.map((fr) => {
                    const ag = agents.find((a) => agentMatchesFixedRole(a, fr.role));
                    if (ag) {
                      return (
                        <button
                          key={fr.role}
                          type="button"
                          className={`mu-dropdown-item ${!groupChatActive && ag.id === activeAgentId ? 'is-active' : ''}`}
                          onClick={() => { onSelectAgent?.(ag.id); setOpenMenu(null); }}
                        >
                          <span className="mu-mode-item-row"><span className="mu-send-menu-glyph">{fr.icon}</span>{ag.name !== fr.label ? `${ag.name} · ${fr.label}` : fr.label}</span>
                          {ag.id === activeAgentId && <span className="mu-item-check">✓</span>}
                        </button>
                      );
                    }
                    return (
                      <button key={fr.role} type="button" className="mu-dropdown-item" disabled title="该固定岗暂未上岗">
                        <span className="mu-mode-item-row"><span className="mu-send-menu-glyph">{fr.icon}</span>{fr.label} · <small className="muted">未上岗</small></span>
                      </button>
                    );
                  })}
                  {/* 自定义员工（非固定岗） */}
                  {agents.filter((a) => !isFixedRoleAgent(a)).map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className={`mu-dropdown-item ${!groupChatActive && a.id === activeAgentId ? 'is-active' : ''}`}
                      onClick={() => { onSelectAgent?.(a.id); setOpenMenu(null); }}
                    >
                      <span className="mu-mode-item-row"><span className="mu-send-menu-glyph">👤</span>{a.name}</span>
                      {a.id === activeAgentId && <span className="mu-item-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mu-prompt-actions">
          {/* 模型选择（2026-08-23 定案：右侧；无清单也显示「选择模型」占位——自动识别清单是下一专项） */}
          {modelOptions && onSelectModel && (
            <div className="mu-composer-popover-wrap">
              {menuButton('model', (
                <>
                  <span className="mu-pill-icon">🧠</span>
                  <span className="mu-pill-label">{currentModelLabel}</span>
                  <span className="mu-pill-arrow">▾</span>
                </>
              ), '切换模型')}
              {openMenu === 'model' && (
                <div className="mu-composer-dropdown" style={{ left: 'auto', right: 0 }}>
                  <div className="mu-dropdown-header">选择模型</div>
                  {models.length === 0 && <span className="mu-dropdown-item is-static">未发现模型——在执行器中心配置</span>}
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

          {/* 思考深度（2026-08-23 定案：展开菜单选择，不再是点击循环切换） */}
          {onToggleThinking && (
            <div className="mu-composer-popover-wrap">
              {menuButton('think', (
                <>
                  <span className="mu-pill-icon">💭</span>
                  <span className="mu-pill-label">{thinkingLabel}</span>
                  <span className="mu-pill-arrow">▾</span>
                </>
              ), '思考深度')}
              {openMenu === 'think' && (
                <div className="mu-composer-dropdown" style={{ left: 'auto', right: 0 }}>
                  <div className="mu-dropdown-header">思考深度</div>
                  {([
                    { id: 'off', label: '关', hint: '不启用思考' },
                    { id: 'low', label: '快', hint: '轻量思考，速度优先' },
                    { id: 'med', label: '中', hint: '平衡思考与耗时' },
                    { id: 'high', label: '深', hint: '充分思考，质量优先' },
                  ] as const).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`mu-dropdown-item ${t.id === thinkingDepth ? 'is-active' : ''}`}
                      onClick={() => { onToggleThinking(t.id); setOpenMenu(null); }}
                    >
                      <span>{t.label} <small className="muted">{t.hint}</small></span>
                      {t.id === thinkingDepth && <span className="mu-item-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* 2026-08-24 定案：⇧↵ 换行提示悬浮发送钮上方居中；⌄ 菜单=全局暂停/全局停止——只针对当前任务：
              在跑才可选，没跑置灰（后台其他 agent 的任务不在此管，各有自己的停止入口）。 */}
          {stopRequested && (
            <span
              className="mu-stop-waiting"
              title="已请求暂停，正在等任务到达安全边界（写文件等写完/命令等跑完/等模型直接停）；超时自动强停并保留现场"
            >
              ⏸ 暂停中…
            </span>
          )}
          <div className="mu-send-group">
            <div className="mu-send-anchor">
              <span className="mu-composer-hint mu-send-hint" title="Shift+Enter 换行">⇧↵ 换行</span>
              <Button
                size="sm"
                variant="primary"
                loading={loading}
                disabled={(!text.trim() && attachments.length === 0 && !quotedContext && !panelQuote) || disabled}
                onClick={handleSend}
                className="mu-composer-send-btn"
                aria-label="发送"
              >
                <span aria-hidden="true">↑</span>
              </Button>
            </div>
            {onStop && (
              <div className="mu-composer-popover-wrap">
                <button
                  type="button"
                  className="mu-composer-pill"
                  aria-label="当前任务暂停或停止"
                  title={isRunning ? '当前任务：全局暂停 / 全局停止' : '当前任务未在执行'}
                  onClick={() => setOpenMenu(openMenu === 'send' ? null : 'send')}
                >
                  <span className="mu-pill-arrow">⌄</span>
                </button>
                {openMenu === 'send' && (
                  <div className="mu-composer-dropdown mu-send-menu" style={{ left: 'auto', right: 0, bottom: '100%', marginBottom: 4, minWidth: 0, width: 'max-content' }}>
                    <button
                      type="button"
                      className="mu-dropdown-item"
                      disabled={!isRunning || stopRequested}
                      onClick={() => { setOpenMenu(null); onStop(); }}
                      title="暂停当前任务的执行（等安全边界停下，保留现场可恢复）"
                    >
                      <span className="mu-send-menu-row"><span className="mu-send-menu-glyph">⏸️</span>全局暂停</span>
                    </button>
                    <button
                      type="button"
                      className="mu-dropdown-item"
                      disabled={!isRunning || stopRequested}
                      onClick={() => { setOpenMenu(null); onStopImmediate?.(); }}
                      title="立刻终止当前任务执行——不等边界，现场保留在打断记录里。急救用，如误跑破坏性命令"
                    >
                      <span className="mu-send-menu-row"><span className="mu-send-menu-glyph">⛔️</span>全局停止</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
