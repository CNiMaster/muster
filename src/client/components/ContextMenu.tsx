/**
 * ContextMenu · 右键上下文菜单（受控浮层）。
 *
 * fixed 定位于鼠标坐标，点击外部/ESC/滚动关闭；items 接口与 DropdownMenu 一致（MenuItem[]），
 * 与任务顶栏 ⋯ 菜单共用同一份 items（2026-08-23 用户定案：右键任务=同款菜单）。
 */
import type React from 'react';
import { useEffect, useRef } from 'react';
import type { MenuItem } from './DropdownMenu';

export interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
}

export const CLOSED_CONTEXT_MENU: ContextMenuState = { open: false, x: 0, y: 0 };

export function ContextMenu({ state, onClose, items }: {
  state: ContextMenuState;
  onClose: () => void;
  items: MenuItem[];
}): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state.open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [state.open, onClose]);

  if (!state.open) return null;

  // 贴边：菜单超出视口右/下缘时翻转到指针左/上方
  const width = 230;
  const estHeight = items.reduce((h, it) => h + (it.divider ? 9 : 31), 0);
  const left = Math.min(state.x, Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(state.y, Math.max(8, window.innerHeight - estHeight - 8));

  return (
    <div
      ref={panelRef}
      role="menu"
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 80,
        minWidth: 180,
        background: 'var(--bg-raised, #fff)',
        border: '1px solid var(--border, #ddd)',
        borderRadius: 10,
        boxShadow: '0 12px 32px rgba(0,0,0,.16)',
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
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
        )
      ))}
    </div>
  );
}
