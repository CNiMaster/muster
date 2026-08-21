import { lazy, StrictMode, Suspense } from 'react';
import type React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/global.css';
import { App } from './App';
import { useToasts, ToastHost } from './components/Button';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RealtimeSync } from './realtime';
import { ProjectToolPageShell, TaskDetailProjectShell } from './components/workbench/ProjectToolPageShell';

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
const ReportsPage = lazyRetry(() => import('./pages/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const DashboardPage = lazyRetry(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const WorkflowGraphPage = lazyRetry(() => import('./pages/WorkflowGraphPage').then((m) => ({ default: m.WorkflowGraphPage })));
const CharacterGraphPage = lazyRetry(() => import('./pages/CharacterGraphPage').then((m) => ({ default: m.CharacterGraphPage })));
const StoragePage = lazyRetry(() => import('./pages/StoragePage').then((m) => ({ default: m.StoragePage })));
const SettingsPage = lazyRetry(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
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

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <ProjectPage /> },
      { path: 'projects/new', element: <ProjectPage /> },
      { path: 'archive', element: <ArchivePage /> },
      { path: 'automations', element: <AutomationPage /> },
      { path: 'blueprints', element: <BlueprintLibraryPage /> },
      { path: 'blueprints/:blueprintId', element: <BlueprintDetailPage /> },
      { path: 'blueprints/:blueprintId/canvas', element: <BlueprintCanvasPage /> },
      { path: 'blueprints/:blueprintId/optimize', element: <BlueprintOptimizePage /> },
      { path: 'graphs/:kind', element: <GraphPage /> },
      { path: 'workflows/:workflowId', element: <WorkflowGraphPage /> },
      { path: 'projects/:projectId', element: <ProjectPage /> },
      { path: 'projects/:projectId/character-graph', element: <ProjectToolPageShell tool="character"><CharacterGraphPage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/tasks', element: <ProjectToolPageShell tool="tasks"><TasksPage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/merges', element: <ProjectToolPageShell tool="merges"><ProjectMergesPage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/plans', element: <ProjectToolPageShell tool="plans"><ProjectPlansPage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/usage', element: <ProjectToolPageShell tool="usage"><UsagePage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/artifacts', element: <ProjectToolPageShell tool="artifacts"><ArtifactsPage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/materials', element: <ProjectToolPageShell tool="materials"><MaterialsPage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/reports', element: <ProjectToolPageShell tool="reports"><ReportsPage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/dashboard', element: <ProjectToolPageShell tool="dashboard"><DashboardPage /></ProjectToolPageShell> },
      { path: 'projects/:projectId/settings', element: <ProjectToolPageShell tool="settings"><ProjectSettingsPage /></ProjectToolPageShell> },
      { path: 'tasks/:taskId', element: <TaskDetailProjectShell><TaskDetailPage /></TaskDetailProjectShell> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'storage', element: <StoragePage /> },
      { path: 'agents', element: <AgentLibraryPage /> },
      { path: 'agents/:profileId', element: <AgentProfilePage /> },
      { path: 'executors', element: <ExecutorCenterPage /> },
      { path: 'permissions', element: <PermissionCenterPage /> },
      { path: 'capabilities', element: <CapabilityCenterPage /> },
      { path: 'marketplace', element: <MarketplacePage /> },
      { path: 'reviews', element: <BusinessReviewPage /> },
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
