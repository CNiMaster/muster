import React, { useState } from 'react';
import { Button } from './Button';

/**
 首次使用引导（PRD Phase 8，清单 281）。
 - localStorage 标记是否已看过。
 - 4 步引导：创建公司 → 组建团队 → 创建项目 → 发布 Task。
 - 用户可手动关闭（不再显示），或在完成首公司后自动隐藏。
 */
const STORAGE_KEY = 'muster:onboarding:v1';

export function OnboardingGuide({ hasCompany }: { hasCompany: boolean }): React.ReactNode {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  // 已有公司则自动隐藏（用户已经会用了）
  if (dismissed || hasCompany) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // localStorage 不可用时仅本地隐藏
    }
    setDismissed(true);
  };

  return (
    <div className="mu-onboarding" style={{
      border: '1px solid var(--accent)',
      borderRadius: 'var(--radius-md)',
      padding: 'var(--space-4)',
      background: 'var(--bg-elevated)',
      marginBottom: 'var(--space-4)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-3)' }}>
        <h3 style={{ margin: 0 }}>👋 欢迎使用 Muster Agent 公司工作台</h3>
        <Button size="sm" variant="ghost" onClick={dismiss}>我知道了</Button>
      </div>
      <p className="muted" style={{ margin: '0 0 var(--space-3)' }}>
        按顺序完成四步，就能让团队开始工作：
      </p>
      <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <li>
          <strong>创建公司</strong>：描述目标并选择合适的公司模板。
        </li>
        <li>
          <strong>组建团队</strong>：确认模板自带的岗位，也可以按需要增减员工。
        </li>
        <li>
          <strong>创建项目</strong>：为实际工作建立独立目录和任务沙盒。
        </li>
        <li>
          <strong>发布 Task</strong>：告诉团队要完成什么，Muster 会分配、执行并跟踪结果。
        </li>
      </ol>
    </div>
  );
}
