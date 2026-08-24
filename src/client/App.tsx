import type React from 'react';
import { Outlet } from 'react-router-dom';
import { useSystemSettings } from './hooks/queries';
import { useAppearance } from './hooks/useAppearance';
import { useTaskNotifications } from './hooks/useTaskNotifications';
import { ErrorBoundary } from './components/ErrorBoundary';

export function App(): React.ReactElement {
  const { data: systemSettings } = useSystemSettings();
  useAppearance(systemSettings);
  useTaskNotifications();
  return (
    <ErrorBoundary label="App">
      <div className="app-shell">
        <main>
          {/* 页面级边界：单页崩溃不影响导航与其他页 */}
          <ErrorBoundary label="Page">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </ErrorBoundary>
  );
}
