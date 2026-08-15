/**
 * PromptComposer · 现代自适应复合输入框组件
 * 
 * 对齐 Codex / Gemini 桌面端体验：
 * - Textarea 根据内容平滑自增高（1 行 ~ 8 行自适应）
 * - 底部集成控制栏：
 *   1. 模型选择器（Model Switcher）
 *   2. 人设/角色切换药丸（Persona Selector）
 *   3. 思考深度开关（Thinking Depth: Off/Low/Med/High）
 *   4. 附件添加（Attach Files/Materials）
 *   5. 发送按钮（Enter 发送，Shift+Enter 换行）
 */
import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { Agent } from '../../api/types';
import { Button } from '../Button';

export interface PromptComposerProps {
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  agents?: Agent[];
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
  currentModel?: string;
  onSelectModel?: (model: string) => void;
  thinkingDepth?: 'off' | 'low' | 'med' | 'high';
  onToggleThinking?: (depth: 'off' | 'low' | 'med' | 'high') => void;
  onSend: (content: string, options?: { agentId?: string; model?: string; thinking?: string }) => void;
  onAttachFile?: () => void;
}

const AVAILABLE_MODELS = [
  { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet (推荐)' },
  { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  { id: 'custom-cli', label: '系统默认执行器' },
];

export function PromptComposer({
  placeholder = '描述你想完成的事，或向智能体交代任务…',
  disabled = false,
  loading = false,
  agents = [],
  selectedAgentId,
  onSelectAgent,
  currentModel = 'claude-3-7-sonnet',
  onSelectModel,
  thinkingDepth = 'high',
  onToggleThinking,
  onSend,
  onAttachFile,
}: PromptComposerProps): React.ReactElement {
  const [text, setText] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const personaMenuRef = useRef<HTMLDivElement>(null);

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

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
      if (personaMenuRef.current && !personaMenuRef.current.contains(e.target as Node)) {
        setPersonaOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = (): void => {
    if (!text.trim() || disabled || loading) return;
    onSend(text.trim(), {
      agentId: selectedAgentId,
      model: currentModel,
      thinking: thinkingDepth,
    });
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = '42px';
    }
  };

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const currentModelLabel = AVAILABLE_MODELS.find((m) => m.id === currentModel)?.label ?? currentModel;

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

  const thinkingLabel = {
    off: '思考: 关',
    low: '思考: 快速',
    med: '思考: 中等',
    high: '思考: 深度',
  }[thinkingDepth];

  return (
    <div className={`mu-prompt-composer ${disabled ? 'is-disabled' : ''}`}>
      <textarea
        ref={textareaRef}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        className="mu-prompt-textarea"
      />

      <div className="mu-prompt-toolbar">
        <div className="mu-prompt-controls">
          {/* 模型切换下拉 */}
          <div className="mu-composer-popover-wrap" ref={modelMenuRef}>
            <button
              type="button"
              className="mu-composer-pill"
              onClick={() => setModelOpen(!modelOpen)}
              title="切换使用的语言模型"
            >
              <span className="mu-pill-icon">🧠</span>
              <span className="mu-pill-label">{currentModelLabel}</span>
              <span className="mu-pill-arrow">▾</span>
            </button>
            {modelOpen && (
              <div className="mu-composer-dropdown">
                <div className="mu-dropdown-header">选择语言模型</div>
                {AVAILABLE_MODELS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`mu-dropdown-item ${m.id === currentModel ? 'is-active' : ''}`}
                    onClick={() => {
                      onSelectModel?.(m.id);
                      setModelOpen(false);
                    }}
                  >
                    <span>{m.label}</span>
                    {m.id === currentModel && <span className="mu-item-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 人设选择药丸 */}
          {agents.length > 0 && (
            <div className="mu-composer-popover-wrap" ref={personaMenuRef}>
              <button
                type="button"
                className="mu-composer-pill"
                onClick={() => setPersonaOpen(!personaOpen)}
                title="指定由哪位智能体处理（或自动匹配）"
              >
                <span className="mu-pill-icon">🎭</span>
                <span className="mu-pill-label">{selectedAgent ? `${selectedAgent.name} (${selectedAgent.role})` : '智能体: 自动匹配'}</span>
                <span className="mu-pill-arrow">▾</span>
              </button>
              {personaOpen && (
                <div className="mu-composer-dropdown">
                  <div className="mu-dropdown-header">指定处理智能体</div>
                  <button
                    type="button"
                    className={`mu-dropdown-item ${!selectedAgentId ? 'is-active' : ''}`}
                    onClick={() => {
                      onSelectAgent?.('');
                      setPersonaOpen(false);
                    }}
                  >
                    <span>🎯 自动匹配合适智能体</span>
                    {!selectedAgentId && <span className="mu-item-check">✓</span>}
                  </button>
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className={`mu-dropdown-item ${a.id === selectedAgentId ? 'is-active' : ''}`}
                      onClick={() => {
                        onSelectAgent?.(a.id);
                        setPersonaOpen(false);
                      }}
                    >
                      <span>{a.name} · <small className="muted">{a.role}</small></span>
                      {a.id === selectedAgentId && <span className="mu-item-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 思考深度切换 */}
          <button
            type="button"
            className={`mu-composer-pill ${thinkingDepth !== 'off' ? 'is-highlight' : ''}`}
            onClick={cycleThinking}
            title="切换思考深度模式"
          >
            <span className="mu-pill-icon">💭</span>
            <span className="mu-pill-label">{thinkingLabel}</span>
          </button>

          {/* 添加附件 */}
          {onAttachFile && (
            <button
              type="button"
              className="mu-composer-icon-btn"
              onClick={onAttachFile}
              title="添加文件或素材附件"
            >
              📎
            </button>
          )}
        </div>

        <div className="mu-prompt-actions">
          <span className="mu-composer-hint">Shift+Enter 换行</span>
          <Button
            size="sm"
            variant="primary"
            loading={loading}
            disabled={!text.trim() || disabled}
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
