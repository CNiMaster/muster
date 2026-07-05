/**
 * Skeleton · 加载占位
 *
 shimmer 动画。多变体：text/circle/rect。
 */
import type React from 'react';

export interface SkeletonProps {
  variant?: 'text' | 'rect' | 'circle';
  width?: number | string;
  height?: number | string;
  lines?: number;
  className?: string;
}

export function Skeleton({ variant = 'text', width, height, lines = 1, className }: SkeletonProps): React.ReactElement {
  if (variant === 'text' && lines > 1) {
    return (
      <div className={`mu-skel-stack ${className ?? ''}`}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="mu-skel mu-skel-text"
            style={{ width: i === lines - 1 ? '60%' : '100%' }}
          />
        ))}
      </div>
    );
  }
  const style: React.CSSProperties = {};
  if (width !== undefined) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height !== undefined) style.height = typeof height === 'number' ? `${height}px` : height;
  return <div className={`mu-skel mu-skel-${variant} ${className ?? ''}`} style={style} />;
}

export function CardSkeleton(): React.ReactElement {
  return (
    <div className="mu-card mu-card-e1 mu-card-skel">
      <div className="mu-card-body">
        <Skeleton variant="rect" height={20} width="50%" />
        <div style={{ height: 12 }} />
        <Skeleton lines={3} />
      </div>
    </div>
  );
}
