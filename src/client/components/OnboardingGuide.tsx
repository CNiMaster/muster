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
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg, 12px)',
      padding: 'var(--space-4, 16px)',
      background: 'var(--bg-elevated)',
      marginTop: 'var(--space-4, 16px)',
      marginBottom: 'var(--space-4, 16px)',
      boxShadow: 'var(--shadow-sm, 0 2px 8px rgba(0,0,0,0.04))',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-3, 12px)' }}>
        <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>欢迎使用 Muster Agent 公司工作台</h3>
        <Button size="sm" variant="ghost" onClick={dismiss}>我知道了</Button>
      </div>
      <div style={{ margin: 'var(--space-2, 8px) 0 var(--space-4, 16px)', borderRadius: 'var(--radius-md, 8px)', overflow: 'hidden', border: '1px solid var(--border-subtle, #eee)' }}>
        <img
          src="/images/onboarding_flow.jpg"
          alt="4步上手指引流程图：1.创建公司 2.组建团队 3.创建项目 4.发布任务"
          style={{ width: '100%', height: 'auto', display: 'block', maxHeight: '280px', objectFit: 'cover' }}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
        <div style={{ padding: '8px 12px', background: 'var(--bg-subtle, rgba(0,0,0,0.02))', borderRadius: '6px' }}>
          <strong style={{ display: 'block', color: 'var(--fg-heading)', marginBottom: '2px' }}>1. 创建公司</strong>
          <span className="muted" style={{ fontSize: '0.85rem' }}>选择模板并设定团队目标</span>
        </div>
        <div style={{ padding: '8px 12px', background: 'var(--bg-subtle, rgba(0,0,0,0.02))', borderRadius: '6px' }}>
          <strong style={{ display: 'block', color: 'var(--fg-heading)', marginBottom: '2px' }}>2. 组建团队</strong>
          <span className="muted" style={{ fontSize: '0.85rem' }}>确认岗位并分配各角色员工</span>
        </div>
        <div style={{ padding: '8px 12px', background: 'var(--bg-subtle, rgba(0,0,0,0.02))', borderRadius: '6px' }}>
          <strong style={{ display: 'block', color: 'var(--fg-heading)', marginBottom: '2px' }}>3. 创建项目</strong>
          <span className="muted" style={{ fontSize: '0.85rem' }}>建立工作目录与独立任务沙盒</span>
        </div>
        <div style={{ padding: '8px 12px', background: 'var(--bg-subtle, rgba(0,0,0,0.02))', borderRadius: '6px' }}>
          <strong style={{ display: 'block', color: 'var(--fg-heading)', marginBottom: '2px' }}>4. 发布 Task</strong>
          <span className="muted" style={{ fontSize: '0.85rem' }}>派发工作单并持续追踪进度</span>
        </div>
      </div>
    </div>
  );
}
