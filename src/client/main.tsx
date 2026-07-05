import { StrictMode } from 'react';
import type React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/global.css';
import { App } from './App';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { CompanyPage } from './pages/CompanyPage';
import { GraphPage } from './pages/GraphPage';
import { ProjectPage } from './pages/ProjectPage';
import { TasksPage } from './pages/TasksPage';
import { UsagePage } from './pages/UsagePage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { useToasts, ToastHost } from './components/Button';

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
      { path: 'companies/:companyId', element: <CompanyPage /> },
      { path: 'companies/:companyId/graphs/:kind', element: <GraphPage /> },
      { path: 'companies/:companyId/projects/new', element: <ProjectPage /> },
      { path: 'projects/:projectId', element: <ProjectPage /> },
      { path: 'projects/:projectId/tasks', element: <TasksPage /> },
      { path: 'projects/:projectId/usage', element: <UsagePage /> },
      { path: 'tasks/:taskId', element: <TaskDetailPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <ToastLayer />
    </QueryClientProvider>
  </StrictMode>,
);
