import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from './Button';

/**
 首次使用引导（PRD Phase 8，清单 281）。
 - localStorage 标记是否已看过。
 - 3 步引导：创建公司 → 上班 → 建项目。
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
        三步开始你的第一个 Agent 公司：
      </p>
      <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <li>
          <strong>创建公司</strong>：在下方填入公司名称（如"我的小说工作室"），选择类型后点击创建。
        </li>
        <li>
          <strong>公司上班</strong>：进入公司页面后，点击"公司上班"，员工会自动进入项目开始待命。
        </li>
        <li>
          <strong>创建项目</strong>：在公司页面点击"新建项目"，输入项目愿景，第一负责人会自动开始规划。
          <span className="muted"> 或试试 </span>
          <Link to="/companies/wizard" style={{ color: 'var(--accent)' }}>智能建司向导</Link>
        </li>
      </ol>
    </div>
  );
}
