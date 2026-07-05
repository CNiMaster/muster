/**
 * Card · 通用卡片容器
 *
 - elevation 1/2/3
 - 可点击（hover 反馈 + cursor pointer）
 - 可带标题/操作槽
 */
import type React from 'react';

export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  elevation?: 1 | 2 | 3;
  interactive?: boolean;
  title?: React.ReactNode;
  actions?: React.ReactNode;
  padded?: boolean;
}

export function Card({
  elevation = 1,
  interactive = false,
  title,
  actions,
  padded = true,
  className,
  children,
  ...rest
}: CardProps): React.ReactElement {
  const cls = [
    'mu-card',
    `mu-card-e${elevation}`,
    interactive ? 'mu-card-interactive' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} {...rest}>
      {(title || actions) && (
        <div className="mu-card-head">
          {title && <div className="mu-card-title">{title}</div>}
          {actions && <div className="mu-card-actions">{actions}</div>}
        </div>
      )}
      <div className={padded ? 'mu-card-body' : ''}>{children}</div>
    </div>
  );
}
