/**
 * Tabs · 标签页
 *
 受控/非受控两用。aria: tablist/tab/tabpanel。
 */
import type React from 'react';
import { useState } from 'react';

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
  const active = activeKey ?? internal;
  const setActive = (k: string): void => {
    if (onChange) onChange(k);
    if (activeKey === undefined) setInternal(k);
  };
  const activeItem = items.find((i) => i.key === active) ?? items[0];
  return (
    <div className="mu-tabs">
      <div className="mu-tabs-bar" role="tablist">
        {items.map((it) => (
          <button
            key={it.key}
            role="tab"
            aria-selected={it.key === active}
            className={`mu-tab ${it.key === active ? 'is-active' : ''}`}
            onClick={() => setActive(it.key)}
          >
            {it.label}
          </button>
        ))}
      </div>
      <div className="mu-tabs-panel" role="tabpanel">
        {activeItem?.content}
      </div>
    </div>
  );
}
