import type React from 'react';
import { cloneElement, isValidElement } from 'react';
import { Badge } from './Badge';

/**
 * 设置行（2026-08-24 新手友好定调）：左侧一行标题 + 一行说明，右侧控件。
 * - badge 'required' = 必须配置（首次使用前）；'recommended' = 建议看一眼；不传 = 可选（默认值即最佳实践）。
 * - 控件形态优先级：开关 > 下拉选项 > 输入框（Toggle 在本文件）。
 * - 外层用 <label> 包裹：标题文本即控件的可访问名（点击标题聚焦控件），测试可用 getByLabelText 定位。
 */
export function SettingsRow({ title, hint, badge, children }: {
  title: string;
  hint?: string;
  badge?: 'required' | 'recommended';
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="settings-row">
      <span className="settings-row-main">
        <span className="settings-row-title">
          {badge === 'required' && <Badge tone="warn">必须</Badge>}
          {badge === 'recommended' && <Badge tone="info">建议</Badge>}
          {title}
        </span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </span>
      <span className="settings-row-control">
        {/* 控件注入 aria-label=标题：可访问名精确为设置项名（label 整行文字太长），测试亦可 getByLabelText 定位 */}
        {isValidElement(children)
          ? cloneElement(children as React.ReactElement<{ 'aria-label'?: string }>, { 'aria-label': title })
          : children}
      </span>
    </label>
  );
}

/** 分区小标题（如「首次使用 · 必须配置」「更多行为」折叠前的分组名）。 */
export function SettingsSectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="settings-section-label">{children}</div>;
}

/**
 * 开关（role=switch）：设置页的首选控件形态——一眼看清开/关，不用读选项文字。
 */
export function Toggle({ checked, onChange, label }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle-switch ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

/** 折叠区（默认收起的高级项容器）：summary 一行灰字，点开展开。 */
export function SettingsFold({ summary, children, defaultOpen = false }: {
  summary: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}): React.ReactElement {
  return (
    <details className="settings-fold" open={defaultOpen}>
      <summary>{summary}</summary>
      <div style={{ paddingTop: 4 }}>{children}</div>
    </details>
  );
}
