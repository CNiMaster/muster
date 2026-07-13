import type React from 'react';
import { Link } from 'react-router-dom';
import { useCompanies, useProjects } from '../../hooks/queries';

export interface WorkbenchSectionOption {
  key: string;
  label: string;
  href: string;
}

const GLOBAL_OPTIONS: WorkbenchSectionOption[] = [
  { key: 'companies', label: '公司工作台', href: '/' },
  { key: 'agents', label: '员工库', href: '/agents' },
  { key: 'executors', label: '执行器', href: '/executors' },
  { key: 'permissions', label: '权限', href: '/permissions' },
  { key: 'settings', label: '设置', href: '/settings' },
];

export function companySectionOptions(companyId: string): WorkbenchSectionOption[] {
  return [
    { key: 'overview', label: '公司概览', href: `/companies/${companyId}` },
    { key: 'projects', label: '项目', href: `/companies/${companyId}?view=projects` },
    { key: 'team', label: '员工看板', href: `/companies/${companyId}?view=team` },
    { key: 'activity', label: '沟通与活动', href: `/companies/${companyId}?view=activity` },
    { key: 'settings', label: '公司设置', href: `/companies/${companyId}?view=settings` },
  ];
}

export function projectSectionOptions(projectId: string, projectTaskId?: string, novel = false): WorkbenchSectionOption[] {
  const taskQuery = `?view=task${projectTaskId ? `&projectTask=${projectTaskId}` : ''}`;
  const viewQuery = (view: string): string => `?view=${view}${projectTaskId ? `&projectTask=${projectTaskId}` : ''}`;
  return [
    { key: 'employee', label: '第一负责人', href: `/projects/${projectId}${viewQuery('employee')}` },
    { key: 'group', label: '项目群聊', href: `/projects/${projectId}${viewQuery('group')}` },
    { key: 'task', label: '项目任务', href: `/projects/${projectId}${taskQuery}` },
    { key: 'activity', label: '协作活动', href: `/projects/${projectId}${viewQuery('activity')}` },
    { key: 'tasks', label: '任务领取清单', href: `/projects/${projectId}/tasks` },
    { key: 'plans', label: '计划与自动化', href: `/projects/${projectId}/plans` },
    { key: 'dashboard', label: '运行概览', href: `/projects/${projectId}/dashboard` },
    { key: 'artifacts', label: '成果与文件', href: `/projects/${projectId}/artifacts` },
    { key: 'reports', label: '复盘', href: `/projects/${projectId}/reports` },
    { key: 'usage', label: '用量', href: `/projects/${projectId}/usage` },
    ...(novel ? [{ key: 'character', label: '人物关系', href: `/projects/${projectId}/character-graph` }] : []),
    { key: 'settings', label: '项目设置', href: `/projects/${projectId}/settings` },
  ];
}

function SwitchMenu({ label, options, activeKey, ariaLabel }: { label: string; options: WorkbenchSectionOption[]; activeKey?: string; ariaLabel: string }): React.ReactElement {
  return <details className="workbench-switch-menu">
    <summary aria-label={ariaLabel}><span>{label}</span><span className="workbench-switch-chevron" aria-hidden="true">⌄</span></summary>
    <div className="workbench-switch-popover">
      {options.map((option) => <Link key={option.key} className={option.key === activeKey ? 'is-active' : ''} to={option.href}>{option.label}{option.key === activeKey && <span aria-hidden="true">✓</span>}</Link>)}
    </div>
  </details>;
}

export function WorkbenchContextSwitcher({ companyId, companyName, companyKind, projectId, projectName, projectTaskId, sectionKey, sectionLabel, novel = false }: {
  companyId: string;
  companyName: string;
  companyKind?: string;
  projectId?: string;
  projectName?: string;
  projectTaskId?: string;
  sectionKey: string;
  sectionLabel: string;
  novel?: boolean;
}): React.ReactElement {
  const { data: companies = [] } = useCompanies();
  const { data: projects = [] } = useProjects(companyId);
  const sections = projectId ? projectSectionOptions(projectId, projectTaskId, novel) : companySectionOptions(companyId);
  const companyOptions = companies.map((company) => ({ key: company.id, label: company.name, href: `/companies/${company.id}` }));
  const projectOptions = projects.map((project) => ({ key: project.id, label: project.name, href: `/projects/${project.id}` }));

  return <nav className="workbench-context-switcher" aria-label="工作区快速切换">
    <SwitchMenu label={projectId ? '项目' : companyKind || '公司'} options={GLOBAL_OPTIONS} ariaLabel="切换功能分类" />
    <span className="workbench-context-separator" aria-hidden="true">/</span>
    <SwitchMenu label={companyName} options={companyOptions} activeKey={companyId} ariaLabel="切换公司" />
    {projectId && projectName && <>
      <span className="workbench-context-separator" aria-hidden="true">/</span>
      <SwitchMenu label={projectName} options={projectOptions} activeKey={projectId} ariaLabel="切换项目" />
    </>}
    <span className="workbench-context-separator" aria-hidden="true">/</span>
    <SwitchMenu label={sectionLabel} options={sections} activeKey={sectionKey} ariaLabel="切换当前分类" />
  </nav>;
}
