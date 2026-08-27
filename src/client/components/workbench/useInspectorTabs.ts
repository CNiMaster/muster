/**
 * 右栏统一标签系统的动作层（2026-08-27 P2）。状态唯一权威=URL（`?rt=` 数组 + `?rtA=` 活动指针），
 * 因此任意树位置的消费者各自从 router hooks 推导即天然一致，无需共享 Context 或外部 store。
 * 纯函数见 inspector-tabs.ts；宿主渲染见 InspectorTabsHost.tsx。
 */
import { useCallback } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  RT_ACTIVE_PARAM,
  RT_CONTEXT_ID,
  RT_PARAM,
  type ProjectToolTabKey,
  type RtEntry,
  activeAfterClose,
  appendRt,
  normalizeRtActive,
  parseRtParam,
  rtId,
  serializeRt,
} from './inspector-tabs';

/** 工具页旧路由 → tab key。 */
const ROUTE_TOOL_RE = /^\/projects\/([^/]+)\/(tasks|merges|artifacts|knowledge)$/;

export function routeToolKey(pathname: string): ProjectToolTabKey | null {
  const match = ROUTE_TOOL_RE.exec(pathname);
  const tool = match?.[2];
  return tool === 'tasks' || tool === 'merges' || tool === 'artifacts' || tool === 'knowledge'
    ? tool
    : null;
}

export interface InspectorTabsApi {
  entries: RtEntry[];
  activeId: string | null;
  ids: Set<string>;
  /** 当前地址停在某支工具的旧路由上时为该工具 key（旧深链直访场景，宿主负责归一注册）。 */
  pathnameTool: ProjectToolTabKey | null;
  openDoc: (path: string) => void;
  openPlan: () => void;
  /** 开工具：已开则仅激活；在旧路由上重复点击同款 = 关闭回现场（沿用左栏开关语义）。 */
  toggleTool: (tool: ProjectToolTabKey) => void;
  closeTab: (id: string) => void;
  activate: (id: string | null) => void;
}

export function useInspectorTabsApi(): InspectorTabsApi {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { projectId = '' } = useParams();

  const entries = parseRtParam(searchParams.get(RT_PARAM));
  const activeId = normalizeRtActive(searchParams.get(RT_ACTIVE_PARAM), entries);
  const pathnameTool = routeToolKey(location.pathname);

  /** 回现场路由：保留 projectTask 深链，view 归位任务视图。 */
  const navigateContext = useCallback(() => {
    if (!projectId) return;
    const taskParam = searchParams.get('projectTask');
    navigate(`/projects/${projectId}?view=task${taskParam ? `&projectTask=${encodeURIComponent(taskParam)}` : ''}`);
  }, [navigate, projectId, searchParams]);

  const openDoc = useCallback((path: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = parseRtParam(prev.get(RT_PARAM));
      const entry: RtEntry = { kind: 'doc', path };
      const id = rtId(entry);
      next.set(RT_PARAM, serializeRt(appendRt(current, entry)));
      next.set(RT_ACTIVE_PARAM, id);
      next.delete('preview'); // 吸收旧单槽参数，防双源打架
      return next;
    });
  }, [setSearchParams]);

  const openPlan = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = parseRtParam(prev.get(RT_PARAM));
      const entry: RtEntry = { kind: 'plan', name: 'live' };
      const id = rtId(entry);
      next.set(RT_PARAM, serializeRt(appendRt(current, entry)));
      next.set(RT_ACTIVE_PARAM, id);
      next.delete('panel');
      return next;
    });
  }, [setSearchParams]);

  const activate = useCallback((id: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set(RT_ACTIVE_PARAM, id); // RT_CONTEXT_ID 是合法哨兵：显式回现场
      else next.delete(RT_ACTIVE_PARAM);
      return next;
    });
  }, [setSearchParams]);

  const closeTab = useCallback((id: string) => {
    const closing = entries.find((e) => rtId(e) === id);
    // 关的是经由旧路由打开的工具签 → 地址也要离开旧路由，才能与标签态一致
    const leavesLegacyRoute = !!(
      pathnameTool &&
      closing?.kind === 'tool' &&
      closing.tool === pathnameTool
    );
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = parseRtParam(prev.get(RT_PARAM));
      next.set(RT_PARAM, serializeRt(current.filter((e) => rtId(e) !== id)));
      const wanted = activeAfterClose(current, id, normalizeRtActive(prev.get(RT_ACTIVE_PARAM), current));
      // wanted=null = 应回现场——必须写显式哨兵，删参数会回落到"最后一张"产生错误激活
      next.set(RT_ACTIVE_PARAM, wanted ?? RT_CONTEXT_ID);
      return next;
    });
    if (leavesLegacyRoute) navigateContext();
  }, [entries, pathnameTool, navigateContext, setSearchParams]);

  const toggleTool = useCallback((tool: ProjectToolTabKey) => {
    const existing = entries.find((e) => e.kind === 'tool' && e.tool === tool);
    const routeOnThisTool = pathnameTool === tool;
    if (existing && activeId === rtId(existing)) {
      closeTab(rtId(existing));
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = parseRtParam(prev.get(RT_PARAM));
      const entry: RtEntry = { kind: 'tool', tool };
      const id = rtId(entry);
      next.set(RT_PARAM, serializeRt(appendRt(current, entry)));
      next.set(RT_ACTIVE_PARAM, id);
      return next;
    });
    // 停在另一支工具的旧路由上开新工具：回现场路由（中栏保持任务对话），标签条接管切换
    if (pathnameTool && !routeOnThisTool) navigateContext();
  }, [entries, activeId, pathnameTool, navigateContext, closeTab, setSearchParams]);

  return { entries, activeId, ids: new Set(entries.map(rtId)), pathnameTool, openDoc, openPlan, toggleTool, closeTab, activate };
}
