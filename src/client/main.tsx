import { lazy, StrictMode, Suspense } from 'react';
import type React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/global.css';
import { App } from './App';
import { useToasts, ToastHost } from './components/Button';
import { RealtimeSync } from './realtime';

const HomePage = lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));
const CompanyPage = lazy(() => import('./pages/CompanyPage').then((m) => ({ default: m.CompanyPage })));
const GraphPage = lazy(() => import('./pages/GraphPage').then((m) => ({ default: m.GraphPage })));
const ProjectPage = lazy(() => import('./pages/ProjectPage').then((m) => ({ default: m.ProjectPage })));
const TasksPage = lazy(() => import('./pages/TasksPage').then((m) => ({ default: m.TasksPage })));
const UsagePage = lazy(() => import('./pages/UsagePage').then((m) => ({ default: m.UsagePage })));
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage').then((m) => ({ default: m.TaskDetailPage })));
const ArtifactsPage = lazy(() => import('./pages/ArtifactsPage').then((m) => ({ default: m.ArtifactsPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const WorkflowGraphPage = lazy(() => import('./pages/WorkflowGraphPage').then((m) => ({ default: m.WorkflowGraphPage })));
const CompanyWizardPage = lazy(() => import('./pages/CompanyWizardPage').then((m) => ({ default: m.CompanyWizardPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));

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
      { index: true, element: <HomePage /> },
      { path: 'companies/wizard', element: <CompanyWizardPage /> },
      { path: 'companies/:companyId', element: <CompanyPage /> },
      { path: 'companies/:companyId/graphs/:kind', element: <GraphPage /> },
      { path: 'companies/:companyId/workflows/:workflowId', element: <WorkflowGraphPage /> },
      { path: 'companies/:companyId/projects/new', element: <ProjectPage /> },
      { path: 'projects/:projectId', element: <ProjectPage /> },
      { path: 'projects/:projectId/tasks', element: <TasksPage /> },
      { path: 'projects/:projectId/usage', element: <UsagePage /> },
      { path: 'projects/:projectId/artifacts', element: <ArtifactsPage /> },
      { path: 'projects/:projectId/reports', element: <ReportsPage /> },
      { path: 'projects/:projectId/dashboard', element: <DashboardPage /> },
      { path: 'tasks/:taskId', element: <TaskDetailPage /> },
      { path: 'settings', element: <SettingsPage /> },
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
      <Suspense fallback={<div className="loading">加载中…</div>}>
        <RouterProvider router={router} />
      </Suspense>
      <ToastLayer />
    </QueryClientProvider>
  </StrictMode>,
);
