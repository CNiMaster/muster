import type React from 'react';
import { Link } from 'react-router-dom';
import { useProjects } from '../../hooks/queries';

export interface WorkbenchSectionOption {
  key: string;
  label: string;
  href: string;
}

export function companySectionOptions(companyId: string): WorkbenchSectionOption[] {
  return [
    { key: 'overview', label: '工作台总览', href: `/companies/${companyId}` },
    { key: 'attention', label: '需要处理', href: `/companies/${companyId}?view=attention` },
    { key: 'projects', label: '项目', href: `/companies/${companyId}?view=projects` },
    { key: 'team', label: '团队', href: `/companies/${companyId}?view=team` },
    { key: 'activity', label: '沟通与活动', href: `/companies/${companyId}?view=activity` },
    { key: 'settings', label: '更多设置', href: `/companies/${companyId}?view=settings` },
  ];
}

export function projectSectionOptions(projectId: string, projectTaskId?: string, novel = false): WorkbenchSectionOption[] {
  const taskQuery = `?view=task${projectTaskId ? `&projectTask=${projectTaskId}` : ''}`;
  const viewQuery = (view: string): string => `?view=${view}${projectTaskId ? `&projectTask=${projectTaskId}` : ''}`;
  return [
    { key: 'task', label: '项目任务', href: `/projects/${projectId}${taskQuery}` },
    { key: 'group', label: '项目群聊', href: `/projects/${projectId}${viewQuery('group')}` },
    { key: 'employee', label: '第一负责人', href: `/projects/${projectId}${viewQuery('employee')}` },
    { key: 'tasks', label: '任务清单', href: `/projects/${projectId}/tasks` },
    { key: 'dashboard', label: '运行概览', href: `/projects/${projectId}/dashboard` },
    { key: 'artifacts', label: '成果文件', href: `/projects/${projectId}/artifacts` },
    { key: 'activity', label: '协作活动', href: `/projects/${projectId}${viewQuery('activity')}` },
    { key: 'plans', label: '计划与自动化', href: `/projects/${projectId}/plans` },
    ...(novel ? [{ key: 'character', label: '人物关系', href: `/projects/${projectId}/character-graph` }] : []),
    { key: 'settings', label: '项目设置', href: `/projects/${projectId}/settings` },
  ];
}

function SwitchMenu({ label, options, activeKey, ariaLabel }: { label: string; options: WorkbenchSectionOption[]; activeKey?: string; ariaLabel: string }): React.ReactElement {
  return (
    <details className="workbench-switch-menu">
      <summary aria-label={ariaLabel}>
        <span>{label}</span>
        <span className="workbench-switch-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="workbench-switch-popover">
        {options.map((option) => (
          <Link key={option.key} className={option.key === activeKey ? 'is-active' : ''} to={option.href}>
            {option.label}
            {option.key === activeKey && <span aria-hidden="true">✓</span>}
          </Link>
        ))}
      </div>
    </details>
  );
}

export function WorkbenchContextSwitcher({ companyId, projectId, projectName, projectTaskId, sectionKey, sectionLabel, novel = false }: {
  companyId?: string;
  companyName?: string;
  companyKind?: string;
  projectId?: string;
  projectName?: string;
  projectTaskId?: string;
  sectionKey: string;
  sectionLabel: string;
  novel?: boolean;
}): React.ReactElement {
  const { data: projects = [] } = useProjects(companyId);
  const sections = projectId ? projectSectionOptions(projectId, projectTaskId, novel) : [];
  const projectOptions = projects.map((project) => ({ key: project.id, label: project.name, href: `/projects/${project.id}` }));

  return (
    <nav className="workbench-context-switcher" aria-label="项目快速切换" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <Link to="/" style={{ fontWeight: 800, fontSize: '13px', color: 'var(--fg)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--accent)' }} />
        <span>Muster</span>
      </Link>

      {projectId && projectName && (
        <>
          <span className="workbench-context-separator" aria-hidden="true" style={{ color: 'var(--fg-subtle)' }}>/</span>
          <SwitchMenu label={projectName} options={projectOptions} activeKey={projectId} ariaLabel="切换项目" />
        </>
      )}

      {sectionLabel && (
        <>
          <span className="workbench-context-separator" aria-hidden="true" style={{ color: 'var(--fg-subtle)' }}>/</span>
          <SwitchMenu label={sectionLabel} options={sections} activeKey={sectionKey} ariaLabel="切换视图" />
        </>
      )}
    </nav>
  );
}
