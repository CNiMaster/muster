import type React from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CompanySectionKey } from '../company/CompanySections';

const dailyItems: Array<{ key: CompanySectionKey; label: string; icon: string }> = [
  { key: 'conversation', label: '对话', icon: '✎' },
  { key: 'overview', label: '工作台总览', icon: '◎' },
  { key: 'projects', label: '项目', icon: '▣' },
  { key: 'attention', label: '需要处理', icon: '!' },
];
const teamItems: Array<{ key: CompanySectionKey; label: string; icon: string }> = [
  { key: 'team', label: '团队', icon: '人' },
  { key: 'activity', label: '沟通与活动', icon: '◌' },
];
const fixedItems: Array<{ key: CompanySectionKey; label: string; icon: string }> = [
  { key: 'evolution', label: '进化与报告', icon: '◈' },
  { key: 'settings', label: '更多设置', icon: '…' },
];

function itemButton({ item, active, counts, onChange }: {
  item: { key: CompanySectionKey; label: string; icon: string };
  active: CompanySectionKey;
  counts: Partial<Record<CompanySectionKey, number>>;
  onChange: (key: CompanySectionKey) => void;
}): React.ReactElement {
  const count = counts[item.key];
  return <button key={item.key} type="button" className={`work-nav-item ${active === item.key ? 'is-active' : ''}`} aria-current={active === item.key ? 'page' : undefined} onClick={() => onChange(item.key)}>
    <span className="work-nav-icon" aria-hidden="true">{item.icon}</span><span className="work-nav-label">{item.label}</span>
    {count !== undefined && count > 0 && <span className="work-nav-count">{count}</span>}
  </button>;
}

export function CompanyWorkNavigation({ active, projectCount, employeeCount, attentionCount, evolutionCount, onChange }: {
  active: CompanySectionKey;
  projectCount: number;
  employeeCount: number;
  attentionCount: number;
  /** E5 补齐：待审批的组织优化建议数（进化 tab 红点）。 */
  evolutionCount: number;
  onChange: (key: CompanySectionKey) => void;
}): React.ReactElement {
  const { companyId } = useParams<{ companyId: string }>();
  return <>
    <div className="work-nav-section">
      <div className="work-nav-heading"><span>日常工作</span></div>
      {dailyItems.map((item) => itemButton({ item, active, counts: { projects: projectCount, attention: attentionCount }, onChange }))}
    </div>
    <div className="work-nav-section">
      <div className="work-nav-heading"><span>团队与沟通</span></div>
      {teamItems.map((item) => itemButton({ item, active, counts: { team: employeeCount }, onChange }))}
    </div>
    <div className="work-nav-section">
      <div className="work-nav-heading"><span>固定入口</span></div>
      {fixedItems.map((item) => itemButton({ item, active, counts: { evolution: evolutionCount }, onChange }))}
      {/* 蓝图组织批次2/3：归档（跨项目知识库）与蓝图库（组织=f(活) 的可视化）入口。 */}
      <Link className="work-nav-item" to={`/companies/${companyId}/archive`}>
        <span className="work-nav-icon" aria-hidden="true">▦</span><span className="work-nav-label">归档</span>
      </Link>
      <Link className="work-nav-item" to={`/companies/${companyId}/blueprints`}>
        <span className="work-nav-icon" aria-hidden="true">▦</span><span className="work-nav-label">蓝图库</span>
      </Link>
    </div>
  </>;
}
