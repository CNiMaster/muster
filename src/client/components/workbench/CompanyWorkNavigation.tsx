import type React from 'react';
import type { CompanySectionKey } from '../company/CompanySections';

const items: Array<{ key: CompanySectionKey; label: string; icon: string }> = [
  { key: 'overview', label: '公司概览', icon: '◎' },
  { key: 'projects', label: '项目', icon: '▣' },
  { key: 'team', label: '组织架构', icon: '人' },
  { key: 'activity', label: '沟通与活动', icon: '◌' },
  { key: 'settings', label: '更多设置', icon: '…' },
];

export function CompanyWorkNavigation({ active, projectCount, employeeCount, attentionCount, onChange }: {
  active: CompanySectionKey;
  projectCount: number;
  employeeCount: number;
  attentionCount: number;
  onChange: (key: CompanySectionKey) => void;
}): React.ReactElement {
  return <div className="work-nav-section">
    <div className="work-nav-heading"><span>公司工作</span>{attentionCount > 0 && <span>{attentionCount} 待处理</span>}</div>
    {items.map((item) => <button key={item.key} type="button" className={`work-nav-item ${active === item.key ? 'is-active' : ''}`} aria-current={active === item.key ? 'page' : undefined} onClick={() => onChange(item.key)}>
      <span className="work-nav-icon" aria-hidden="true">{item.icon}</span><span className="work-nav-label">{item.label}</span>
      {item.key === 'projects' && <span className="work-nav-count">{projectCount}</span>}
      {item.key === 'team' && <span className="work-nav-count">{employeeCount}</span>}
      {item.key === 'overview' && attentionCount > 0 && <span className="work-nav-count">{attentionCount}</span>}
    </button>)}
  </div>;
}
