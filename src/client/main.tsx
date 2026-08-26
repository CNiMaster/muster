import { lazy, StrictMode, Suspense } from 'react';
import type React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/global.css';
import { App } from './App';
import { useUiMode } from './hooks/queries';
import { useToasts, ToastHost } from './components/Button';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RealtimeSync } from './realtime';
import { ProjectToolPageShell, TaskDetailProjectShell, GlobalToolPageShell } from './components/workbench/ProjectToolPageShell';

/**
 * 包裹 React.lazy 的动态 import，失败时自动重试一次。
 *
 * 动态 import 失败的最常见原因是 dev server 在请求瞬间不可达（崩溃/重启）。
 * 这类瞬时错误重试通常即可恢复；即便重试仍失败，外层 ErrorBoundary 会渲染友好兜底，
 * 而不是把裸的 "Failed to fetch dynamically imported module" 抛给用户。
 */
function lazyRetry<T extends React.ComponentType<any>>(loader: () => Promise<{ default: T }>): React.LazyExoticComponent<T> {
  const retried = { current: false };
  const load = (): Promise<{ default: T }> => {
    const attempt = (): Promise<{ default: T }> => loader();
    return attempt().catch((err) => {
      if (retried.current) throw err;
      retried.current = true;
      return attempt();
    });
  };
  return lazy(load);
}

const HomePage = lazyRetry(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const NotFoundPage = lazyRetry(() => import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));
const GraphPage = lazyRetry(() => import('./pages/GraphPage').then((m) => ({ default: m.GraphPage })));
const ProjectPage = lazyRetry(() => import('./pages/ProjectPage').then((m) => ({ default: m.ProjectPage })));
const TasksPage = lazyRetry(() => import('./pages/TasksPage').then((m) => ({ default: m.TasksPage })));
const ProjectMergesPage = lazyRetry(() => import('./pages/ProjectMergesPage').then((m) => ({ default: m.ProjectMergesPage })));
const UsagePage = lazyRetry(() => import('./pages/UsagePage').then((m) => ({ default: m.UsagePage })));
const TaskDetailPage = lazyRetry(() => import('./pages/TaskDetailPage').then((m) => ({ default: m.TaskDetailPage })));
const ArtifactsPage = lazyRetry(() => import('./pages/ArtifactsPage').then((m) => ({ default: m.ArtifactsPage })));
const MaterialsPage = lazyRetry(() => import('./pages/MaterialsPage').then((m) => ({ default: m.MaterialsPage })));
const KnowledgeBasePage = lazyRetry(() => import('./pages/KnowledgeBasePage').then((m) => ({ default: m.KnowledgeBasePage })));
const MemoryBoardPage = lazyRetry(() => import('./pages/MemoryBoardPage').then((m) => ({ default: m.MemoryBoardPage })));
const CommandsPage = lazyRetry(() => import('./pages/CommandsPage').then((m) => ({ default: m.CommandsPage })));
const ReportsPage = lazyRetry(() => import('./pages/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const DashboardPage = lazyRetry(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const WorkflowGraphPage = lazyRetry(() => import('./pages/WorkflowGraphPage').then((m) => ({ default: m.WorkflowGraphPage })));
const CharacterGraphPage = lazyRetry(() => import('./pages/CharacterGraphPage').then((m) => ({ default: m.CharacterGraphPage })));
const StoragePage = lazyRetry(() => import('./pages/StoragePage').then((m) => ({ default: m.StoragePage })));
const SettingsPage = lazyRetry(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const SideChatPage = lazyRetry(() => import('./pages/SideChatPage').then((m) => ({ default: m.SideChatPage })));
const AgentLibraryPage = lazyRetry(() => import('./pages/AgentLibraryPage').then((m) => ({ default: m.AgentLibraryPage })));
const AgentProfilePage = lazyRetry(() => import('./pages/AgentProfilePage').then((m) => ({ default: m.AgentProfilePage })));
const ExecutorCenterPage = lazyRetry(() => import('./pages/ExecutorCenterPage').then((m) => ({ default: m.ExecutorCenterPage })));
const PermissionCenterPage = lazyRetry(() => import('./pages/PermissionCenterPage').then((m) => ({ default: m.PermissionCenterPage })));
const CapabilityCenterPage = lazyRetry(() => import('./pages/CapabilityCenterPage').then((m) => ({ default: m.CapabilityCenterPage })));
const MarketplacePage = lazyRetry(() => import('./pages/MarketplacePage').then((m) => ({ default: m.MarketplacePage })));
const BusinessReviewPage = lazyRetry(() => import('./pages/BusinessReviewPage').then((m) => ({ default: m.BusinessReviewPage })));
const ProjectSettingsPage = lazyRetry(() => import('./pages/ProjectSettingsPage').then((m) => ({ default: m.ProjectSettingsPage })));
const ProjectPlansPage = lazyRetry(() => import('./pages/ProjectPlansPage').then((m) => ({ default: m.ProjectPlansPage })));
const ArchivePage = lazyRetry(() => import('./pages/ArchivePage').then((m) => ({ default: m.ArchivePage })));
const AutomationPage = lazyRetry(() => import('./pages/AutomationPage').then((m) => ({ default: m.AutomationPage })));
const BlueprintLibraryPage = lazyRetry(() => import('./pages/BlueprintLibraryPage').then((m) => ({ default: m.BlueprintLibraryPage })));
const BlueprintDetailPage = lazyRetry(() => import('./pages/BlueprintDetailPage').then((m) => ({ default: m.BlueprintDetailPage })));
const BlueprintCanvasPage = lazyRetry(() => import('./pages/BlueprintCanvasPage').then((m) => ({ default: m.BlueprintCanvasPage })));
const BlueprintOptimizePage = lazyRetry(() => import('./pages/BlueprintOptimizePage').then((m) => ({ default: m.BlueprintOptimizePage })));

function ToastLayer(): React.ReactElement {
  const { toasts, dismiss } = useToasts();
  return <ToastHost toasts={toasts} dismiss={dismiss} />;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false },
  },
});


/**
 * 治理批次5：专业页路由门——简单模式下访问专业页面给提示页（可一键切换），
 * 不做静默重定向（用户需要知道"内容在，只是被模式收起来了"）。
 */
function ModeGate({ children }: { children: React.ReactElement }): React.ReactElement {
  const ui = useUiMode();
  const navigate = useNavigate();
  if (!ui.isSimple) return children;
  return (
    <div style={{ minHeight: '60vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 700 }}>这一页属于专业模式</div>
      <div style={{ fontSize: 13, color: 'var(--fg-subtle)', maxWidth: 360, textAlign: 'center' }}>
        当前是简单模式：专注把任务说清楚、直接开干。专业工具（蓝图/执行器/合并看板等）收起来了。
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="mu-btn mu-btn-primary mu-btn-sm" onClick={() => ui.setUiMode('pro')} disabled={ui.saving}>切换到专业模式</button>
        <button type="button" className="mu-btn mu-btn-ghost mu-btn-sm" onClick={() => navigate(-1)}>返回</button>
      </div>
    </div>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <ProjectPage /> },
      { path: 'projects/new', element: <ProjectPage /> },
      { path: 'projects/manage', element: <HomePage /> },
      { path: 'archive', element: <GlobalToolPageShell label="归档" pane="inspector"><ArchivePage /></GlobalToolPageShell> },
      { path: 'memory-board', element: <GlobalToolPageShell label="记忆看板"><ModeGate><MemoryBoardPage /></ModeGate></GlobalToolPageShell> },
      { path: 'commands', element: <GlobalToolPageShell label="命令库"><ModeGate><CommandsPage /></ModeGate></GlobalToolPageShell> },
      { path: 'automations', element: <GlobalToolPageShell label="自动化中心"><ModeGate><AutomationPage /></ModeGate></GlobalToolPageShell> },
      { path: 'blueprints', element: <GlobalToolPageShell label="蓝图库"><ModeGate><BlueprintLibraryPage /></ModeGate></GlobalToolPageShell> },
      { path: 'blueprints/:blueprintId', element: <GlobalToolPageShell label="蓝图详情"><ModeGate><BlueprintDetailPage /></ModeGate></GlobalToolPageShell> },
      { path: 'blueprints/:blueprintId/canvas', element: <GlobalToolPageShell label="蓝图画布" fullHeight><ModeGate><BlueprintCanvasPage /></ModeGate></GlobalToolPageShell> },
      { path: 'blueprints/:blueprintId/optimize', element: <GlobalToolPageShell label="蓝图优化"><ModeGate><BlueprintOptimizePage /></ModeGate></GlobalToolPageShell> },
      { path: 'graphs/:kind', element: <ModeGate><GraphPage /></ModeGate> },
      { path: 'workflows/:workflowId', element: <ModeGate><WorkflowGraphPage /></ModeGate> },
      { path: 'projects/:projectId', element: <ProjectPage /> },
      { path: 'projects/:projectId/character-graph', element: <ProjectToolPageShell tool="character"><CharacterGraphPage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/tasks', element: <ProjectToolPageShell tool="tasks"><ModeGate><TasksPage /></ModeGate></ProjectToolPageShell> },
      { path: 'projects/:projectId/merges', element: <ProjectToolPageShell tool="merges"><ModeGate><ProjectMergesPage /></ModeGate></ProjectToolPageShell> },
      { path: 'projects/:projectId/plans', element: <ProjectToolPageShell tool="plans"><ModeGate><ProjectPlansPage /></ModeGate></ProjectToolPageShell> },
      { path: 'projects/:projectId/usage', element: <ProjectToolPageShell tool="usage"><ModeGate><UsagePage /></ModeGate></ProjectToolPageShell> },
      { path: 'projects/:projectId/artifacts', element: <ProjectToolPageShell tool="artifacts"><ArtifactsPage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/materials', element: <ProjectToolPageShell tool="materials"><MaterialsPage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/knowledge', element: <ProjectToolPageShell tool="knowledge"><KnowledgeBasePage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/reports', element: <ProjectToolPageShell tool="reports"><ModeGate><ReportsPage /></ModeGate></ProjectToolPageShell> },
      { path: 'projects/:projectId/dashboard', element: <ProjectToolPageShell tool="dashboard"><ModeGate><DashboardPage /></ModeGate></ProjectToolPageShell> },
      { path: 'projects/:projectId/settings', element: <ProjectToolPageShell tool="settings"><ProjectSettingsPage /></ProjectToolPageShell> },
      { path: 'tasks/:taskId', element: <TaskDetailProjectShell><TaskDetailPage /></TaskDetailProjectShell> },
      { path: 'side', element: <GlobalToolPageShell label="侧边对话" pane="inspector" fullHeight><SideChatPage /></GlobalToolPageShell> },
      { path: 'settings', element: <GlobalToolPageShell label="系统设置"><SettingsPage /></GlobalToolPageShell> },
      { path: 'storage', element: <GlobalToolPageShell label="存储管理"><StoragePage /></GlobalToolPageShell> },
      { path: 'agents', element: <GlobalToolPageShell label="智能体人才库"><ModeGate><AgentLibraryPage /></ModeGate></GlobalToolPageShell> },
      { path: 'agents/:profileId', element: <GlobalToolPageShell label="智能体档案"><ModeGate><AgentProfilePage /></ModeGate></GlobalToolPageShell> },
      { path: 'executors', element: <GlobalToolPageShell label="执行器中心"><ModeGate><ExecutorCenterPage /></ModeGate></GlobalToolPageShell> },
      { path: 'permissions', element: <GlobalToolPageShell label="权限中心"><ModeGate><PermissionCenterPage /></ModeGate></GlobalToolPageShell> },
      { path: 'capabilities', element: <GlobalToolPageShell label="能力中心"><ModeGate><CapabilityCenterPage /></ModeGate></GlobalToolPageShell> },
      { path: 'marketplace', element: <GlobalToolPageShell label="能力市场"><ModeGate><MarketplacePage /></ModeGate></GlobalToolPageShell> },
      { path: 'reviews', element: <GlobalToolPageShell label="业务评审"><ModeGate><BusinessReviewPage /></ModeGate></GlobalToolPageShell> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RealtimeSync />
      <ErrorBoundary label="页面加载">
        <Suspense fallback={<div className="loading">加载中…</div>}>
          <RouterProvider router={router} />
        </Suspense>
      </ErrorBoundary>
      <ToastLayer />
    </QueryClientProvider>
  </StrictMode>,
);
