import type React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useSystemSettings } from './hooks/queries';
import { useAppearance } from './hooks/useAppearance';
import { ErrorBoundary } from './components/ErrorBoundary';
import { CompanyTabBar } from './components/workbench/CompanyTabBar';

export function App(): React.ReactElement {
  const location = useLocation();
  const { data: systemSettings } = useSystemSettings();
  useAppearance(systemSettings);
  // 改版 2b：CompanyTabBar 在所有路由常驻（取代旧的扁平顶栏 + 双导航模型）。
  void location;
  return (
    <ErrorBoundary label="App">
      <div className="app-shell">
        <CompanyTabBar />
        <main className="main">
          {/* 页面级边界：单页崩溃不影响导航与其他页 */}
          <ErrorBoundary label="Page">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </ErrorBoundary>
  );
}
