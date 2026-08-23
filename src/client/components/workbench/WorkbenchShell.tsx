import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import { WorkbenchGuide } from './WorkbenchGuide';
import { useUiMode } from '../../hooks/queries';
import { toast } from '../Button';
import { DEFAULT_WORKBENCH_PREFERENCES, PANE_WIDTH_BOUNDS, WORKBENCH_DESKTOP_MIN, surfaceMinWidthFor, useWorkbenchPreferences } from './useWorkbenchPreferences';

/**
 * 面板开关下放：中栏内容（如任务顶栏的「右侧面板」按钮）可经此 context
 * 复用 Shell 的左右面板开合状态，不重复建偏好存储。
 */
export const WorkbenchUIContext = createContext<{ toggleRight: () => void; toggleLeft: () => void } | null>(null);
export function useWorkbenchUI(): { toggleRight: () => void; toggleLeft: () => void } | null {
  return useContext(WorkbenchUIContext);
}

/** 栏宽拖拽手柄——拖动实时预览（不落盘），松手才持久化；双击重置默认宽度；方向键微调。 */
function WorkbenchResizer({ side, width, onResize, onActiveChange }: {
  side: 'left' | 'right';
  width: number;
  onResize: (px: number, commit: boolean) => void;
  onActiveChange: (active: boolean) => void;
}): React.ReactElement {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  // 评审修复：视口跨过桌面阈值或面板被关时手柄会带着进行中的拖拽卸载——unmount 时提交在途宽度并复位状态，
  // 否则 liveWidths 内存覆盖残留、is-resizing（禁 transition/user-select）卡死整个会话。
  const lastWidthRef = useRef(width);
  lastWidthRef.current = width;
  useEffect(
    () => () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      onActiveChange(false);
      onResize(lastWidthRef.current, true);
    },
    // 仅 unmount 清理：闭包回调经 ref 保真，无需响应 prop 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const bounds = PANE_WIDTH_BOUNDS[side];
  const defaultWidth = side === 'left' ? DEFAULT_WORKBENCH_PREFERENCES.leftWidth : DEFAULT_WORKBENCH_PREFERENCES.rightWidth;

  return (
    <div
      className={`workbench-resizer is-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? '调整左侧列表宽度' : '调整右侧信息栏宽度'}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.focus();
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
        // 指针捕获保证移出手柄区域仍持续收到事件；不可用时退化为普通拖拽
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onActiveChange(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        // 左栏向右拖变宽；右栏向左拖变宽
        const delta = side === 'left' ? event.clientX - drag.startX : drag.startX - event.clientX;
        onResize(Math.min(bounds.max, Math.max(bounds.min, drag.startWidth + delta)), false);
      }}
      onPointerUp={() => {
        if (!dragRef.current) return;
        dragRef.current = null;
        onActiveChange(false);
        onResize(lastWidthRef.current, true);
      }}
      onPointerCancel={() => {
        if (!dragRef.current) return;
        dragRef.current = null;
        onActiveChange(false);
        onResize(lastWidthRef.current, true);
      }}
      onDoubleClick={() => onResize(defaultWidth, true)}
      onKeyDown={(event) => {
        const grow = side === 'left' ? event.key === 'ArrowRight' : event.key === 'ArrowLeft';
        const shrink = side === 'left' ? event.key === 'ArrowLeft' : event.key === 'ArrowRight';
        if (!grow && !shrink) return;
        event.preventDefault();
        onResize(width + (grow ? 16 : -16), true);
      }}
    />
  );
}

/**
 * 布局重构（2026-08-23 用户定案）：左栏=全局导航 rail（到顶全高：品牌/⌘K/模式切换+导航树）；
 * 右区=工作区（顶栏 breadcrumb/下班/主操作 + 中栏现场 + 右栏检视器——右栏附属中栏）。
 * ≥740px 真三栏共存（可拖拽）；<740px 左右栏退化为互斥抽屉（手机/平板竖屏）。
 */
export function WorkbenchShell({ scopeKey, breadcrumb, navigationLabel, inspectorLabel, navigation, inspector, primaryAction, attentionCount = 0, commandOptions, children }: {
  scopeKey: string;
  breadcrumb: React.ReactNode;
  navigationLabel: string;
  inspectorLabel: string;
  navigation: React.ReactNode;
  inspector: React.ReactNode;
  primaryAction?: React.ReactNode;
  attentionCount?: number;
  commandOptions?: Array<{ label: string; href: string; group?: string; proOnly?: boolean }>;
  children: React.ReactNode;
}): React.ReactElement {
  const preferences = useWorkbenchPreferences(scopeKey);
  const ui = useUiMode();
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [resizingPane, setResizingPane] = useState<'left' | 'right' | null>(null);
  const commandOpenRef = useRef(false);
  commandOpenRef.current = commandOpen;

  // 简单模式下专业项不再隐藏——灰态 +「专业」小标可见，点击提示切换（原来直接 filter 掉）
  const globalOptions: Array<{ label: string; href: string; group: string; proOnly?: boolean }> = [
    { label: '首页', href: '/', group: '全局' },
    { label: '新建项目', href: '/projects/new', group: '全局' },
    { label: '归档', href: '/archive', group: '全局' },
    { label: '存储管理', href: '/storage', group: '全局' },
    { label: '设置', href: '/settings', group: '全局' },
    // 专业模式专属入口（治理批次5语义；G.7 起简单模式可见但锁定）
    { label: '蓝图库', href: '/blueprints', group: '全局', proOnly: true },
    { label: '自动化', href: '/automations', group: '全局', proOnly: true },
    { label: '智能体库', href: '/agents', group: '全局', proOnly: true },
    { label: '执行器', href: '/executors', group: '全局', proOnly: true },
    { label: '权限', href: '/permissions', group: '全局', proOnly: true },
    { label: '审批', href: '/reviews', group: '全局', proOnly: true },
  ];
  const options = [...(commandOptions ?? []), ...globalOptions];
  const query = commandQuery.trim().toLowerCase();
  const visible = query ? options.filter((option) => `${option.group ?? ''}${option.label}`.toLowerCase().includes(query)) : options;
  const groups = Array.from(new Set(visible.map((option) => option.group ?? '当前')));
  const isDesktop = preferences.viewportWidth >= WORKBENCH_DESKTOP_MIN;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(true); }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); preferences.toggleLeft(); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); preferences.toggleRight(); }
      if (event.key === 'Escape') {
        if (commandOpenRef.current) { setCommandOpen(false); return; }
        if (typeof window !== 'undefined' && window.innerWidth < WORKBENCH_DESKTOP_MIN && (preferences.leftOpen || preferences.rightOpen)) preferences.closeDrawers();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preferences.toggleLeft, preferences.toggleRight, preferences.closeDrawers, preferences.leftOpen, preferences.rightOpen]);

  const style = {
    '--work-left': `${preferences.leftWidth}px`,
    '--work-right': `${preferences.rightWidth}px`,
    '--work-surface-min': `${surfaceMinWidthFor(preferences.viewportWidth)}px`,
  } as React.CSSProperties;
  return <WorkbenchUIContext.Provider value={{ toggleRight: preferences.toggleRight, toggleLeft: preferences.toggleLeft }}>
  <section className={`workbench ${preferences.leftOpen ? 'has-left' : ''} ${preferences.rightOpen ? 'has-right' : ''} ${resizingPane ? 'is-resizing' : ''}`} style={style}>
    <nav id="work-navigation" className="workbench-navigation" aria-label={navigationLabel}>
      <div className="workbench-rail-top">
        <Link to="/" className="workbench-brand" aria-label="Muster 首页"><span>M</span></Link>
        <button type="button" className="workbench-command" aria-label="搜索或跳转" onClick={() => setCommandOpen(true)}><kbd>⌘ K</kbd><span>搜索或跳转</span></button>
        <button type="button" className="workbench-icon-button" title={preferences.leftOpen ? '收起左侧工作列表' : '展开左侧工作列表'} aria-label={preferences.leftOpen ? '收起工作列表' : '展开工作列表'} aria-expanded={preferences.leftOpen} aria-controls="work-navigation" onClick={preferences.toggleLeft}><span className="pane-toggle-glyph is-left" aria-hidden="true" /></button>
      </div>
      <div className="workbench-rail-body">{preferences.leftOpen ? navigation : null}</div>
      <div className="workbench-rail-foot">
        <button type="button" className="workbench-icon-button" title={ui.isSimple ? '当前是简单模式：专注任务对话。点击切换到专业模式。' : '当前是专业模式：全量功能。点击切换回简单模式。'} aria-label={ui.isSimple ? '切换到专业模式' : '切换到简单模式'} onClick={ui.toggle} disabled={ui.saving} style={{ fontSize: 12, width: 'auto', padding: '0 8px' }}>{ui.isSimple ? '简单' : '专业'}</button>
      </div>
    </nav>
    <div className="workbench-main">
      <header className="workbench-header">
        {/* 左栏收起（桌面态 rail 整体隐藏）或抽屉态（<740）时，rail 里的开关/模式切换失去入口——这里补条件渲染 */}
        {(!isDesktop || !preferences.leftOpen) && (
          <>
            <button type="button" className="workbench-icon-button" title={preferences.leftOpen ? '收起左侧工作列表' : '展开左侧工作列表'} aria-label={preferences.leftOpen ? '收起工作列表' : '展开工作列表'} aria-expanded={preferences.leftOpen} aria-controls="work-navigation" onClick={preferences.toggleLeft}><span className="pane-toggle-glyph is-left" aria-hidden="true" /></button>
            <button type="button" className="workbench-icon-button" title={ui.isSimple ? '当前是简单模式：专注任务对话。点击切换到专业模式。' : '当前是专业模式：全量功能。点击切换回简单模式。'} aria-label={ui.isSimple ? '切换到专业模式' : '切换到简单模式'} onClick={ui.toggle} disabled={ui.saving} style={{ fontSize: 12, width: 'auto', padding: '0 8px' }}>{ui.isSimple ? '简单' : '专业'}</button>
          </>
        )}
        <div className="workbench-breadcrumb">{breadcrumb}</div>
        {primaryAction && <div className="workbench-primary-action">{primaryAction}</div>}
        <button type="button" className="workbench-icon-button inspector-toggle" title={preferences.rightOpen ? '收起右侧现场信息' : '展开右侧现场信息'} aria-label={preferences.rightOpen ? '收起现场信息' : '展开现场信息'} aria-expanded={preferences.rightOpen} aria-controls="work-inspector" onClick={preferences.toggleRight}><span className="pane-toggle-glyph is-right" aria-hidden="true" />{attentionCount > 0 && <i>{attentionCount}</i>}</button>
      </header>
      <div className="workbench-grid">
        <main className="workbench-surface">{children}</main>
        <aside id="work-inspector" className="workbench-inspector" aria-label={inspectorLabel}>{preferences.rightOpen ? inspector : null}</aside>
        {/* 桌面态（≥740）栏宽拖拽；抽屉态不渲染 */}
        {isDesktop && preferences.leftOpen && (
          <WorkbenchResizer side="left" width={preferences.leftWidth} onResize={(px, commit) => preferences.setWidth('left', px, commit)} onActiveChange={(active) => setResizingPane(active ? 'left' : null)} />
        )}
        {isDesktop && preferences.rightOpen && (
          <WorkbenchResizer side="right" width={preferences.rightWidth} onResize={(px, commit) => preferences.setWidth('right', px, commit)} onActiveChange={(active) => setResizingPane(active ? 'right' : null)} />
        )}
      </div>
    </div>
    {(!isDesktop && (preferences.leftOpen || preferences.rightOpen)) && <div className="workbench-drawer-backdrop" onMouseDown={preferences.closeDrawers} aria-hidden="true" />}
    <WorkbenchGuide />
    {commandOpen && <div className="command-backdrop" onMouseDown={() => { setCommandOpen(false); setCommandQuery(''); }}><div className="command-dialog" role="dialog" aria-modal="true" aria-label="搜索或跳转" onMouseDown={(event) => event.stopPropagation()}>
      <div className="command-title"><strong>去哪里？</strong><button type="button" aria-label="关闭搜索" onClick={() => { setCommandOpen(false); setCommandQuery(''); }}>×</button></div>
      <input className="command-input" value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="搜索当前项目任务、智能体或全局功能…" autoFocus />
      <div className="command-links">
        {groups.map((group) => <div key={group} className="command-group">
          <div className="command-group-label">{group}</div>
          {visible.filter((option) => (option.group ?? '当前') === group).map((option) => option.proOnly && ui.isSimple ? (
            <button
              key={option.href}
              type="button"
              className="command-item-locked"
              title="专业模式功能——左下角切换到专业模式后可用"
              onClick={() => toast('info', `「${option.label}」是专业模式功能：左下角切到专业模式即可使用`)}
            >
              <span>{option.label}</span><em>专业</em>
            </button>
          ) : (
            <Link key={option.href} to={option.href} onClick={() => { setCommandOpen(false); setCommandQuery(''); }}>{option.label}</Link>
          ))}
        </div>)}
        {visible.length === 0 && <p className="muted command-empty">没有匹配项</p>}
      </div>
    </div></div>}
  </section>
  </WorkbenchUIContext.Provider>;
}
