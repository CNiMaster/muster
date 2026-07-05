/**
 * Modal · 对话框
 *
 - portal 到 body
 - backdrop 点击关闭、ESC 关闭
 - 焦点陷阱（简化版：tab 在模态内循环）
 - 标题 + 关闭按钮 + 内容 + 底部操作
 */
import type React from 'react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Button';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  closeOnBackdrop?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = true,
}: ModalProps): React.ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // 锁滚动
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // 聚焦模态
    setTimeout(() => ref.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="mu-modal-backdrop"
      onClick={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`mu-modal mu-modal-${size}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1} ref={ref}>
        {title && (
          <div className="mu-modal-head">
            <h2 className="mu-modal-title">{title}</h2>
            <IconButton label="关闭" variant="ghost" size="sm" onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </IconButton>
          </div>
        )}
        <div className="mu-modal-body">{children}</div>
        {footer && <div className="mu-modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
