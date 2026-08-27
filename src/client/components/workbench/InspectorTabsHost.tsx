/**
 * 右栏统一标签宿主（2026-08-27 P2，计划：docs/superpowers/plans/2026-08-27-inspector-tabs.md）。
 *
 * - 「现场」（ProjectContextInspector）= 隐式首张，不可关闭；doc(预览)/plan(工作现场)/tool(右栏工具) 为显式标签
 * - 状态权威=URL（?rt= 数组 + ?rtA= 活动指针），本组件只做渲染与旧入口归一：
 *   ① 旧参数 ?preview= / ?panel= 出现时吸收为标签（可分享/可刷新语义不变）
 *   ② 旧工具路由直访（/projects/:id/artifacts 等深链）自动注册为 tool 标签
 * - 保活口径=滚动位置级：切换间记录/恢复各标签 body 的 scrollTop；组件内输入态不保留（跨路由
 *   keep-alive 需门户级改造，本轮明确不做）
 */
import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ModeGate } from '../ModeGate';
import { Button } from '../Button';
import { Modal } from '../Modal';
import { TasksPage } from '../../pages/TasksPage';
import { ProjectMergesPage } from '../../pages/ProjectMergesPage';
import { ArtifactsPage } from '../../pages/ArtifactsPage';
import { KnowledgeBasePage } from '../../pages/KnowledgeBasePage';
import { ArchivePage } from '../../pages/ArchivePage';
import { SideChatPage } from '../../pages/SideChatPage';
import { MemoryBoardPage } from '../../pages/MemoryBoardPage';
import { PreviewBody } from './InspectorPreviewHost';
import { WorkLivePanel } from './WorkLivePanel';
import { rtId, rtLabel, RT_CONTEXT_ID, type GlobalToolKey, type RtEntry } from './inspector-tabs';
import { useInspectorTabsApi } from './useInspectorTabs';
import { ApprovalsInbox } from './ApprovalsInbox';

const GLOBAL_TAB_ICONS: Record<GlobalToolKey, string> = { archive: '🗂️', side: '💬', approvals: '🔔', memory: '🧠' };

/** 标签条 + 活动体。ctxBody=「现场」内容节点（调用方传入，保持既有 props 装配）。 */
export function InspectorTabsHost({ projectId, ctxBody }: { projectId?: string; ctxBody: React.ReactNode }): React.ReactElement {
  const api = useInspectorTabsApi();
  const { entries, activeId } = api;
  // 显式哨兵 ctx=回现场；否则缺省落最后一张（深链直达语义）
  const contextActive = activeId === RT_CONTEXT_ID;
  const defaultActiveId = entries.length > 0 ? rtId(entries[entries.length - 1]) : null;
  const bodyActiveId = contextActive ? null : (activeId ?? defaultActiveId);
  const activeEntry: RtEntry | null = bodyActiveId ? entries.find((e) => rtId(e) === bodyActiveId) ?? null : null;
  // 滚动记账键：显式签用其 id，现场也占一个键
  const scrollKey = bodyActiveId ?? RT_CONTEXT_ID;

  // ── 旧入口归一 ────────────────────────────────────────────────
  const [searchParams] = useSearchParams();
  const legacyPreview = searchParams.get('preview');
  const legacyPanel = searchParams.get('panel');
  useEffect(() => {
    if (legacyPreview) api.openDoc(legacyPreview);
    else if (legacyPanel) api.openPlan();
    // 仅在出现旧参数时动作；openDoc/openPlan 内部按 id 幂等且会删除旧参数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyPreview, legacyPanel]);
  useEffect(() => {
    if (api.pathnameTool && !api.ids.has(`tool:${api.pathnameTool}`)) {
      api.toggleTool(api.pathnameTool);
      return;
    }
    if (api.pathnameGlobalTool && !api.ids.has(`g:${api.pathnameGlobalTool}`)) {
      api.toggleGlobalTool(api.pathnameGlobalTool);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.pathnameTool, api.pathnameGlobalTool, api.ids]);

  // ── 滚动保活（scrollTop 级）────────────────────────────────────
  // 滚动容器是外层 .workbench-inspector（壳层网格定位，Host 不另建滚层）——
  // 单滚动器上按当前活动签实时记账、切签后恢复。
  const scrollMapRef = useRef(new Map<string, number>());
  const currentActiveRef = useRef<string | null>(scrollKey);
  currentActiveRef.current = scrollKey;
  const lastActiveRef = useRef<string | null>(scrollKey);
  const hostRootRef = useRef<HTMLDivElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    asideRef.current = hostRootRef.current?.closest('.workbench-inspector') as HTMLElement | null;
    const el = asideRef.current;
    if (!el) return;
    const onScroll = (): void => {
      if (currentActiveRef.current) scrollMapRef.current.set(currentActiveRef.current, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const el = asideRef.current;
    const prev = lastActiveRef.current;
    if (el && scrollKey !== prev) {
      const saved = scrollMapRef.current.get(scrollKey);
      requestAnimationFrame(() => { el.scrollTop = saved ?? 0; });
    }
    lastActiveRef.current = scrollKey;
  }, [scrollKey]);

  // 放大态属于 doc 标签的阅读增强，随标签切换重置
  const [zoomPath, setZoomPath] = useState<string | null>(null);
  useEffect(() => { setZoomPath(null); }, [scrollKey]);

  // 活动签必须可见：bar 横向可滚但滚动位不跟随内容——切签/归一后把它滚进可视区
  useEffect(() => {
    if (!bodyActiveId || !hostRootRef.current) return;
    const el = hostRootRef.current.querySelector(`[data-tab-id="${CSS.escape(bodyActiveId)}"]`);
    // 可选调用：jsdom 等无 scrollIntoView 的环境直接跳过
    el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [bodyActiveId]);

  return (
    <div ref={hostRootRef} className="inspector-tabs-host">
      {entries.length > 0 && (
        <nav className="inspector-tabs-bar" aria-label="右栏标签页" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={contextActive || entries.length === 0}
            className={`inspector-tab is-context ${contextActive || activeEntry === null ? 'is-active' : ''}`}
            onClick={() => api.activate(RT_CONTEXT_ID)}
            title="回到现场"
          >
            现场
          </button>
          {entries.map((entry) => {
            const id = rtId(entry);
            const isActive = !contextActive && id === bodyActiveId;
            return (
              <span key={id} data-tab-id={id} className={`inspector-tab ${isActive ? 'is-active' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className="inspector-tab-label"
                  title={rtLabel(entry)}
                  onClick={() => { if (!isActive) api.activate(id); }}
                >
                  <span className="inspector-tab-kind" aria-hidden="true">{entry.kind === 'doc' ? '📄' : entry.kind === 'plan' ? '🛠' : entry.kind === 'globalTool' ? GLOBAL_TAB_ICONS[entry.key] : '🧰'}</span>
                  <span className="inspector-tab-text">{rtLabel(entry)}</span>
                </button>
                <button
                  type="button"
                  className="inspector-tab-close"
                  aria-label={`关闭 ${rtLabel(entry)}`}
                  title="关闭"
                  onClick={(event) => { event.stopPropagation(); api.closeTab(id); }}
                >
                  ×
                </button>
              </span>
            );
          })}
        </nav>
      )}
      {/* body 直挂 aside 单滚动器之下；显式签各自渲染，无签时即现场 */}
      <div className="inspector-tabs-body">
        {activeEntry === null && ctxBody}
        {activeEntry?.kind === 'doc' && (
          <DocTabBody
            projectId={projectId ?? ''}
            relPath={activeEntry.path}
            zoomed={zoomPath === activeEntry.path}
            onZoom={() => setZoomPath(activeEntry.path)}
            onCloseZoom={() => setZoomPath(null)}
          />
        )}
        {activeEntry?.kind === 'plan' && <WorkLivePanel projectId={projectId ?? ''} />}
        {activeEntry?.kind === 'tool' && (
          <div className="work-inspector-tool">
            <div className="work-inspector-tool-body">
              {activeEntry.tool === 'tasks' && <ModeGate><TasksPage /></ModeGate>}
              {activeEntry.tool === 'merges' && <ModeGate><ProjectMergesPage /></ModeGate>}
              {activeEntry.tool === 'artifacts' && <ArtifactsPage />}
              {activeEntry.tool === 'knowledge' && <KnowledgeBasePage />}
            </div>
          </div>
        )}
        {activeEntry?.kind === 'globalTool' && (
          <div className="work-inspector-tool">
            <div className="work-inspector-tool-body">
              {activeEntry.key === 'archive' && <ArchivePage />}
              {activeEntry.key === 'side' && <SideChatPage />}
              {/* 专业页：与 /approvals 路由同款 ModeGate（简单模式下分享链接不走标签后门） */}
              {activeEntry.key === 'approvals' && <ModeGate><ApprovalsInbox /></ModeGate>}
              {/* 看板族（2026-08-28 定案：右栏=看板）——记忆看板与审批同属右栏板式；专业页双裁同款 */}
              {activeEntry.key === 'memory' && <ModeGate><MemoryBoardPage /></ModeGate>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DocTabBody({ projectId, relPath, zoomed, onZoom, onCloseZoom }: { projectId: string; relPath: string; zoomed: boolean; onZoom: () => void; onCloseZoom: () => void }): React.ReactElement {
  const fileName = relPath.split('/').pop() ?? relPath;
  return (
    <section className="auxiliary-section inspector-preview">
      <div className="auxiliary-section-title inspector-doc-head">
        <span className="inspector-doc-name" title={relPath}>👁 {fileName}</span>
        <span className="inspector-doc-actions">
          <Button size="sm" variant="ghost" onClick={onZoom}>放大</Button>
          <Link className="mu-btn mu-btn-ghost mu-btn-sm" to={`/projects/${projectId}/artifacts?path=${encodeURIComponent(relPath)}`}>画廊</Link>
        </span>
      </div>
      <PreviewBody projectId={projectId} relPath={relPath} />
      {zoomed && (
        <Modal open onClose={onCloseZoom} title={fileName} size="xl">
          <p className="muted" style={{ margin: '0 0 8px', fontSize: 12, wordBreak: 'break-all' }}>{relPath}</p>
          <PreviewBody projectId={projectId} relPath={relPath} tall />
        </Modal>
      )}
    </section>
  );
}
