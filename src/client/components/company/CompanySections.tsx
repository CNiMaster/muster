import type React from 'react';
import { Tabs } from '../Tabs';

export type CompanySectionKey = 'overview' | 'team' | 'projects' | 'activity' | 'settings' | 'attention' | 'evolution';

export function isCompanySectionKey(value: string | null): value is CompanySectionKey {
  return value === 'overview' || value === 'team' || value === 'projects' || value === 'activity' || value === 'settings' || value === 'attention' || value === 'evolution';
}

export function CompanySections({
  active,
  onChange,
  overview,
  team,
  projects,
  activity,
  evolution,
  settings,
}: {
  active: CompanySectionKey;
  onChange: (key: CompanySectionKey) => void;
  overview: React.ReactNode;
  team: React.ReactNode;
  projects: React.ReactNode;
  activity: React.ReactNode;
  evolution: React.ReactNode;
  settings: React.ReactNode;
}): React.ReactElement {
  return <Tabs
    activeKey={active}
    onChange={(key) => onChange(key as CompanySectionKey)}
    items={[
      { key: 'overview', label: '概览', content: overview },
      { key: 'team', label: '团队', content: team },
      { key: 'projects', label: '项目', content: projects },
      { key: 'activity', label: '活动', content: activity },
      { key: 'evolution', label: '进化', content: evolution },
      { key: 'settings', label: '设置', content: settings },
    ]}
  />;
}
