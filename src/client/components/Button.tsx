/**
 * Button · 共享按钮组件
 *
 variant: primary | ghost | danger | subtle
 size: sm | md
 touch target ≥44px（md），focus ring 键盘可见，loading 态禁用 + spinner。
 */
import type React from 'react';
import { useEffect, useState } from 'react';

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';
type Size = 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps): React.ReactElement {
  const cls = ['mu-btn', `mu-btn-${variant}`, `mu-btn-${size}`, loading ? 'is-loading' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <Spinner />}
      {!loading && icon}
      {children && <span>{children}</span>}
    </button>
  );
}

function Spinner(): React.ReactElement {
  return (
    <svg className="mu-spinner" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M12 7a5 5 0 0 0-5-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="mu-spinner-arc"
      />
    </svg>
  );
}

/** IconButton：图标按钮，aria-label 必填（无障碍）。 */
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  label: string; // aria-label
}

export function IconButton({ label, className, children, ...rest }: IconButtonProps): React.ReactElement {
  const cls = ['mu-btn', 'mu-btn-icon', className ?? ''].filter(Boolean).join(' ');
  return (
    <button className={cls} aria-label={label} {...rest}>
      {children}
    </button>
  );
}

/** useToast：临时提示。简单版，挂在 root 上。 */
export interface Toast {
  id: string;
  kind: 'success' | 'error' | 'info';
  message: string;
}

let toastListeners: ((t: Toast) => void)[] = [];
let toastSeq = 0;

export function toast(kind: Toast['kind'], message: string): void {
  const t: Toast = { id: `t${++toastSeq}`, kind, message };
  for (const l of toastListeners) l(t);
}

export function useToasts(): { toasts: Toast[]; dismiss: (id: string) => void } {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const listener = (t: Toast): void => {
      setItems((cur) => [...cur, t]);
      setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== t.id)), 3500);
    };
    toastListeners = [...toastListeners, listener];
    return () => {
      toastListeners = toastListeners.filter((l) => l !== listener);
    };
  }, []);
  return {
    toasts: items,
    dismiss: (id: string) => setItems((cur) => cur.filter((x) => x.id !== id)),
  };
}

export function ToastHost({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }): React.ReactElement {
  return (
    <div className="mu-toast-host" role="region" aria-label="通知">
      {toasts.map((t) => (
        <div key={t.id} className={`mu-toast mu-toast-${t.kind}`} role="status" onClick={() => dismiss(t.id)}>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
