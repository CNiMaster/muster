/**
 * 治理批次5的专业页路由门：简单模式下给可一键切换的提示页（不静默重定向）。
 * 2026-08-27 从 main.tsx 抽出组件化——右栏标签宿主（InspectorTabsHost）渲染工具体也要过同一道门。
 */
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { useUiMode } from '../hooks/queries';

export function ModeGate({ children }: { children: React.ReactElement }): React.ReactElement {
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
