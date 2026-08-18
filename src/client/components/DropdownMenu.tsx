/**
 * DropdownMenu · 轻量三点/更多菜单。
 *
 * 受控弹出层：触发按钮 + 菜单项列表；点击外部/ESC 关闭，菜单项点击后自动收起。
 * 用于项目行三点菜单、标题旁「＋ 新建」等场景（全仓无弹出层组件，此为公共底座）。
 */
import type React from 'react';
import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  key: string;
  label: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  /** 只渲染分割线，忽略 label/onSelect。 */
  divider?: boolean;
}

export interface DropdownMenuProps {
  /** 触发内容（如 ⋯ 或 ＋）；无障碍标签必填。 */
  label: string;
  children: React.ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  className?: string;
  buttonClassName?: string;
}

export function DropdownMenu({ label, children, items, align = 'right', className, buttonClassName }: DropdownMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`dropdown-menu${className ? ` ${className}` : ''}`} ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        className={buttonClassName}
        onClick={() => setOpen((v) => !v)}
      >
        {children}
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            [align]: 0,
            zIndex: 50,
            minWidth: 160,
            background: 'var(--bg-raised, #fff)',
            border: '1px solid var(--border, #ddd)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,.12)',
            padding: 4,
          }}
        >
          {items.map((item) => (
            item.divider ? (
              <hr key={item.key} style={{ border: 'none', borderTop: '1px solid var(--border-subtle, #eee)', margin: '4px 2px' }} />
            ) : (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                border: 'none',
                background: 'transparent',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                color: item.danger ? 'var(--danger, #c0392b)' : 'inherit',
              }}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
            )
          ))}
        </div>
      )}
    </div>
  );
}
