/**
 * Tabs · 标签页
 *
 受控/非受控两用。aria: tablist/tab/tabpanel。
 键盘：左右方向键切换（WAI-ARIA tabs pattern），Home/End 跳首尾。
 */
import type React from 'react';
import { useId, useState, useRef } from 'react';

export interface TabItem {
  key: string;
  label: React.ReactNode;
  content: React.ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  defaultKey?: string;
  activeKey?: string;
  onChange?: (key: string) => void;
}

export function Tabs({ items, defaultKey, activeKey, onChange }: TabsProps): React.ReactElement {
  const [internal, setInternal] = useState(defaultKey ?? items[0]?.key);
  const tabsId = useId();
  const active = activeKey ?? internal;
  const setActive = (k: string): void => {
    if (onChange) onChange(k);
    if (activeKey === undefined) setInternal(k);
  };
  const tablistRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const idx = items.findIndex((i) => i.key === active);
    if (idx < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next >= 0) {
      e.preventDefault();
      setActive(items[next].key);
      // 把焦点移到新激活的 tab
      setTimeout(() => {
        const btns = tablistRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
        btns?.[next]?.focus();
      }, 0);
    }
  };

  const activeItem = items.find((i) => i.key === active) ?? items[0];
  return (
    <div className="mu-tabs">
      <div className="mu-tabs-bar" role="tablist" ref={tablistRef} onKeyDown={onKeyDown}>
        {items.map((it) => (
          <button
            key={it.key}
            role="tab"
            id={`${tabsId}-tab-${it.key}`}
            aria-controls={`${tabsId}-panel`}
            aria-selected={it.key === active}
            tabIndex={it.key === active ? 0 : -1}
            className={`mu-tab ${it.key === active ? 'is-active' : ''}`}
            onClick={() => setActive(it.key)}
          >
            {it.label}
          </button>
        ))}
      </div>
      <div className="mu-tabs-panel" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-tab-${activeItem?.key ?? ''}`}>
        {activeItem?.content}
      </div>
    </div>
  );
}
