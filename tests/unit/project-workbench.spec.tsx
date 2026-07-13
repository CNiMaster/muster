import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Agent, Department, Task } from '../../src/client/api/types';
import { ProjectWorkNavigation, projectTaskMark } from '../../src/client/components/workbench/ProjectWorkNavigation';
import { companySectionOptions, projectSectionOptions } from '../../src/client/components/workbench/WorkbenchContextSwitcher';

const lead = { id: 'ag_1', profileId: 'ap_1', companyId: 'co_1', departmentId: 'dep_1', name: '研发负责人', role: 'lead', responsibilities: '', systemPrompt: '', skills: [], tools: [], permissions: {}, isInspector: false, canDispatch: true, contactAllow: ['ag_2'], availabilityState: 'online', executor: {}, stance: '' } as Agent;
const engineer = { ...lead, id: 'ag_2', profileId: 'ap_2', name: '后端工程师', role: 'engineer', canDispatch: false } as Agent;
const department = { id: 'dep_1', companyId: 'co_1', name: '工程部', rules: {}, createdAt: '', updatedAt: '' } as Department;
const task = { id: 'tk_1', projectId: 'pr_1', projectTaskId: 'pt_1', seq: 3, title: '实现审批恢复', state: 'running', assigneeAgentId: 'ag_2', dispatcherAgentId: 'ag_1', parentTaskId: null, rootTaskId: null, assigneeThreadId: null, assigneeTaskThreadId: null, outcome: null, summary: '', question: null, inputProtocol: {}, outputProtocol: {}, contextRefs: [], artifacts: [], priority: 5, deadlineAt: null, completedAt: null, clarificationRounds: 0, isDiscussion: 0, createdAt: '', updatedAt: '' } as Task;

describe('project employee-centered workbench', () => {
  it('uses the organization as navigation and nests tasks under employees', () => {
    render(<MemoryRouter><ProjectWorkNavigation projectId="pr_1" projectTasks={[]} tasks={[task]} agents={[lead, engineer]} departments={[department]} firstAgentId="ag_1" selectedProjectTaskId="pt_1" selectedAgentId="ag_2" view="employee" attentionCount={2} novel={false} /></MemoryRouter>);
    expect(screen.getByText('置顶 · 第一负责人')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /研发负责人/ })).toHaveAttribute('href', '/projects/pr_1?view=employee&agent=ag_1&projectTask=pt_1');
    expect(screen.getByRole('link', { name: /项目群聊/ })).toHaveAttribute('href', '/projects/pr_1?view=group&projectTask=pt_1');
    expect(screen.getByRole('link', { name: /后端工程师/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '实现审批恢复' })).toHaveAttribute('href', '/tasks/tk_1');
    expect(screen.getByRole('link', { name: /任务领取清单/ })).toHaveTextContent('2');
  });

  it('keeps meaningful short marks available for project task surfaces', () => {
    expect(projectTaskMark('修复执行器审批桥')).toBe('执行');
    expect(projectTaskMark('建立任务领取清单')).toBe('任务');
  });

  it('builds employee, group, task and automation switcher destinations', () => {
    expect(companySectionOptions('co_1').find((item) => item.key === 'team')?.href).toBe('/companies/co_1?view=team');
    const projectItems = projectSectionOptions('pr_1', 'pt_1');
    expect(projectItems.find((item) => item.key === 'employee')?.href).toBe('/projects/pr_1?view=employee&projectTask=pt_1');
    expect(projectItems.find((item) => item.key === 'group')?.href).toBe('/projects/pr_1?view=group&projectTask=pt_1');
    expect(projectItems.find((item) => item.key === 'task')?.href).toBe('/projects/pr_1?view=task&projectTask=pt_1');
    expect(projectItems.find((item) => item.key === 'plans')?.href).toBe('/projects/pr_1/plans');
    expect(projectItems.some((item) => item.key === 'character')).toBe(false);
    expect(projectSectionOptions('pr_1', 'pt_1', true).some((item) => item.key === 'character')).toBe(true);
  });
});
