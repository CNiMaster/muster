/**
 * EmptyState · 空状态提示
 *
 替代当前"组织图空白""列表 0 项"的视觉断层。
 - icon（SVG）
 - title
 - hint
 - action（按钮）
 */
import type React from 'react';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, hint, action, className }: EmptyStateProps): React.ReactElement {
  return (
    <div className={`mu-empty ${className ?? ''}`}>
      {icon && <div className="mu-empty-icon" aria-hidden="true">{icon}</div>}
      <div className="mu-empty-title">{title}</div>
      {hint && <div className="mu-empty-hint">{hint}</div>}
      {action && <div className="mu-empty-action">{action}</div>}
    </div>
  );
}

/** 常用图标。避免 emoji。 */
export const Icons = {
  empty: (
    <svg width="48" height="48" viewBox="0 0 48 48">
      <rect x="6" y="10" width="36" height="28" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
      <path d="M14 22h20M14 28h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  graph: (
    <svg width="48" height="48" viewBox="0 0 48 48">
      <circle cx="14" cy="16" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="34" cy="14" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="24" cy="34" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M18 18l4 12M30 16l-4 14M19 16h10" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  search: (
    <svg width="48" height="48" viewBox="0 0 48 48">
      <circle cx="22" cy="22" r="12" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M31 31l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
};
