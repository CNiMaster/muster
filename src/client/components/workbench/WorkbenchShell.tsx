import { useEffect, useState } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import { WorkbenchGuide } from './WorkbenchGuide';
import { useWorkbenchPreferences } from './useWorkbenchPreferences';

export function WorkbenchShell({ scopeKey, breadcrumb, navigationLabel, inspectorLabel, navigation, inspector, primaryAction, attentionCount = 0, children }: {
  scopeKey: string;
  breadcrumb: React.ReactNode;
  navigationLabel: string;
  inspectorLabel: string;
  navigation: React.ReactNode;
  inspector: React.ReactNode;
  primaryAction?: React.ReactNode;
  attentionCount?: number;
  children: React.ReactNode;
}): React.ReactElement {
  const preferences = useWorkbenchPreferences(scopeKey);
  const [commandOpen, setCommandOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(true); }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); preferences.toggleLeft(); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); preferences.toggleRight(); }
      if (event.key === 'Escape') setCommandOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preferences.toggleLeft, preferences.toggleRight]);

  const style = { '--work-left': `${preferences.leftWidth}px`, '--work-right': `${preferences.rightWidth}px` } as React.CSSProperties;
  return <section className={`workbench ${preferences.leftOpen ? 'has-left' : ''} ${preferences.rightOpen ? 'has-right' : ''}`} style={style}>
    <header className="workbench-header">
      <Link to="/" className="workbench-brand" aria-label="返回 Muster 首页">M</Link>
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
    <WorkbenchGuide />
    {commandOpen && <div className="command-backdrop" onMouseDown={() => setCommandOpen(false)}><div className="command-dialog" role="dialog" aria-modal="true" aria-label="搜索或跳转" onMouseDown={(event) => event.stopPropagation()}>
      <div className="command-title"><strong>去哪里？</strong><button type="button" aria-label="关闭搜索" onClick={() => setCommandOpen(false)}>×</button></div>
      <div className="command-links"><Link to="/">首页</Link><Link to="/agents">员工库</Link><Link to="/executors">执行器</Link><Link to="/permissions">权限</Link><Link to="/settings">设置</Link></div>
    </div></div>}
  </section>;
}
