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
  image?: string;
  type?: 'general' | 'graph' | 'search';
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}

const DEFAULT_IMAGES: Record<string, string> = {
  general: '/images/empty_general.jpg',
  graph: '/images/empty_graph.jpg',
  search: '/images/empty_search.jpg',
};

export function EmptyState({ icon, image, type = 'general', title, hint, action, className }: EmptyStateProps): React.ReactElement {
  const imgSrc = image ?? DEFAULT_IMAGES[type] ?? DEFAULT_IMAGES.general;

  return (
    <div className={`mu-empty ${className ?? ''}`} style={{ textAlign: 'center', padding: 'var(--space-6, 24px) var(--space-4, 16px)' }}>
      {imgSrc ? (
        <div className="mu-empty-illustration" style={{ maxWidth: '240px', margin: '0 auto 16px', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 4px 12px rgba(0,0,0,0.03)', border: '1px solid var(--border-subtle, #eee)' }}>
          <img src={imgSrc} alt={title} style={{ width: '100%', height: 'auto', display: 'block', objectFit: 'cover' }} />
        </div>
      ) : icon ? (
        <div className="mu-empty-icon" aria-hidden="true">{icon}</div>
      ) : null}
      <div className="mu-empty-title" style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--fg-heading)', marginTop: '8px' }}>{title}</div>
      {hint && <div className="mu-empty-hint" style={{ color: 'var(--fg-muted)', fontSize: '0.88rem', marginTop: '4px', maxWidth: '380px', marginLeft: 'auto', marginRight: 'auto' }}>{hint}</div>}
      {action && <div className="mu-empty-action" style={{ marginTop: '16px' }}>{action}</div>}
    </div>
  );
}

/** 常用图标。避免 emoji。 */
export const Icons = {
  empty: null,
  graph: null,
  search: null,
};

