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

export function EmptyState({ icon, image, title, hint, action, className }: EmptyStateProps): React.ReactElement {
  return (
    <div
      className={`mu-empty ${className ?? ''}`}
      style={{
        textAlign: 'center',
        padding: '32px 16px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
      }}
    >
      {image ? (
        <div
          className="mu-empty-illustration"
          style={{
            maxWidth: '180px',
            margin: '0 auto 12px',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <img src={image} alt={title} style={{ width: '100%', height: 'auto', display: 'block', objectFit: 'cover' }} />
        </div>
      ) : icon ? (
        <div
          className="mu-empty-icon"
          aria-hidden="true"
          style={{
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            background: 'var(--bg-soft)',
            color: 'var(--fg-muted)',
            display: 'grid',
            placeItems: 'center',
            fontSize: '18px',
            marginBottom: '4px',
          }}
        >
          {icon}
        </div>
      ) : (
        <div
          aria-hidden="true"
          style={{
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            background: 'var(--bg-soft)',
            color: 'var(--fg-subtle)',
            display: 'grid',
            placeItems: 'center',
            fontSize: '16px',
            marginBottom: '2px',
          }}
        >
          📂
        </div>
      )}
      <div style={{ fontSize: '14px', fontWeight: 650, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
        {title}
      </div>
      {hint && (
        <div style={{ color: 'var(--fg-muted)', fontSize: '12px', lineHeight: 1.5, maxWidth: '360px', margin: '0 auto' }}>
          {hint}
        </div>
      )}
      {action && <div style={{ marginTop: '12px' }}>{action}</div>}
    </div>
  );
}

export const Icons = {
  empty: '📂',
  graph: '🕸️',
  search: '🔍',
};
