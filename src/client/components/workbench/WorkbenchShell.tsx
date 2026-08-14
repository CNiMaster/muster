import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import { WorkbenchGuide } from './WorkbenchGuide';
import { MIN_WORKBENCH_SURFACE_WIDTH, useWorkbenchPreferences } from './useWorkbenchPreferences';

export function WorkbenchShell({ scopeKey, breadcrumb, navigationLabel, inspectorLabel, navigation, inspector, primaryAction, attentionCount = 0, commandOptions, children }: {
  scopeKey: string;
  breadcrumb: React.ReactNode;
  navigationLabel: string;
  inspectorLabel: string;
  navigation: React.ReactNode;
  inspector: React.ReactNode;
  primaryAction?: React.ReactNode;
  attentionCount?: number;
  commandOptions?: Array<{ label: string; href: string; group?: string }>;
  children: React.ReactNode;
}): React.ReactElement {
  const preferences = useWorkbenchPreferences(scopeKey);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const commandOpenRef = useRef(false);
  commandOpenRef.current = commandOpen;

  const globalOptions = [
    { label: '首页', href: '/', group: '全局' },
    { label: '公司', href: '/companies', group: '全局' },
    { label: '员工库', href: '/agents', group: '全局' },
    { label: '执行器', href: '/executors', group: '全局' },
    { label: '权限', href: '/permissions', group: '全局' },
    { label: '审批', href: '/reviews', group: '全局' },
    { label: '设置', href: '/settings', group: '全局' },
  ];
  const options = [...(commandOptions ?? []), ...globalOptions];
  const query = commandQuery.trim().toLowerCase();
  const visible = query ? options.filter((option) => `${option.group ?? ''}${option.label}`.toLowerCase().includes(query)) : options;
  const groups = Array.from(new Set(visible.map((option) => option.group ?? '当前')));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(true); }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); preferences.toggleLeft(); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); preferences.toggleRight(); }
      if (event.key === 'Escape') {
        if (commandOpenRef.current) { setCommandOpen(false); return; }
        if (typeof window !== 'undefined' && window.innerWidth <= 1179 && (preferences.leftOpen || preferences.rightOpen)) preferences.closeDrawers();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preferences.toggleLeft, preferences.toggleRight, preferences.closeDrawers, preferences.leftOpen, preferences.rightOpen]);

  const style = {
    '--work-left': `${preferences.leftWidth}px`,
    '--work-right': `${preferences.rightWidth}px`,
    '--work-surface-min': `${MIN_WORKBENCH_SURFACE_WIDTH}px`,
  } as React.CSSProperties;
  return <section className={`workbench ${preferences.leftOpen ? 'has-left' : ''} ${preferences.rightOpen ? 'has-right' : ''}`} style={style}>
    <header className="workbench-header">
      {/* 改版收尾：品牌弹出菜单与顶部公司标签栏重复，收敛为纯首页链接 */}
      <Link to="/" className="workbench-brand" aria-label="Muster 首页">
        <img src="/images/brand_logo.jpg" alt="Muster" className="workbench-brand-logo-img" style={{ width: '100%', height: '100%', borderRadius: 'var(--radius-sm, 6px)', objectFit: 'cover' }} />
      </Link>
      <button type="button" className="workbench-icon-button" title={preferences.leftOpen ? '收起左侧工作列表' : '展开左侧工作列表'} aria-label={preferences.leftOpen ? '收起工作列表' : '展开工作列表'} aria-expanded={preferences.leftOpen} aria-controls="work-navigation" onClick={preferences.toggleLeft}><span className="pane-toggle-glyph is-left" aria-hidden="true" /></button>
      <div className="workbench-breadcrumb">{breadcrumb}</div>
      <button type="button" className="workbench-command" aria-label="搜索或跳转" onClick={() => setCommandOpen(true)}><kbd>⌘ K</kbd><span>搜索或跳转</span></button>
      <button type="button" className="workbench-icon-button inspector-toggle" title={preferences.rightOpen ? '收起右侧现场信息' : '展开右侧现场信息'} aria-label={preferences.rightOpen ? '收起现场信息' : '展开现场信息'} aria-expanded={preferences.rightOpen} aria-controls="work-inspector" onClick={preferences.toggleRight}><span className="pane-toggle-glyph is-right" aria-hidden="true" />{attentionCount > 0 && <i>{attentionCount}</i>}</button>
      {primaryAction && <div className="workbench-primary-action">{primaryAction}</div>}
    </header>
    <div className="workbench-grid">
      <nav id="work-navigation" className="workbench-navigation" aria-label={navigationLabel}>{preferences.leftOpen ? navigation : null}</nav>
      <main className="workbench-surface">{children}</main>
      <aside id="work-inspector" className="workbench-inspector" aria-label={inspectorLabel}>{preferences.rightOpen ? inspector : null}</aside>
    </div>
    {(preferences.viewportWidth <= 1179 && (preferences.leftOpen || preferences.rightOpen)) && <div className="workbench-drawer-backdrop" onMouseDown={preferences.closeDrawers} aria-hidden="true" />}
    <WorkbenchGuide />
    {commandOpen && <div className="command-backdrop" onMouseDown={() => { setCommandOpen(false); setCommandQuery(''); }}><div className="command-dialog" role="dialog" aria-modal="true" aria-label="搜索或跳转" onMouseDown={(event) => event.stopPropagation()}>
      <div className="command-title"><strong>去哪里？</strong><button type="button" aria-label="关闭搜索" onClick={() => { setCommandOpen(false); setCommandQuery(''); }}>×</button></div>
      <input className="command-input" value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="搜索当前项目任务、员工或全局功能…" autoFocus />
      <div className="command-links">
        {groups.map((group) => <div key={group} className="command-group">
          <div className="command-group-label">{group}</div>
          {visible.filter((option) => (option.group ?? '当前') === group).map((option) => <Link key={option.href} to={option.href} onClick={() => { setCommandOpen(false); setCommandQuery(''); }}>{option.label}</Link>)}
        </div>)}
        {visible.length === 0 && <p className="muted command-empty">没有匹配项</p>}
      </div>
    </div></div>}
  </section>;
}
