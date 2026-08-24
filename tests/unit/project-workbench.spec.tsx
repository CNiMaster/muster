import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Agent, Department, Task } from '../../src/client/api/types';
import { ProjectWorkNavigation, projectTaskMark } from '../../src/client/components/workbench/ProjectWorkNavigation';
import { projectSectionOptions } from '../../src/client/components/workbench/WorkbenchContextSwitcher';

const lead = { id: 'ag_1', profileId: 'ap_1', companyId: 'co_1', departmentId: 'dep_1', name: '研发负责人', role: 'lead', responsibilities: '', systemPrompt: '', skills: [], tools: [], permissions: {}, isInspector: false, canDispatch: true, contactAllow: ['ag_2'], availabilityState: 'online', executor: {}, stance: '' } as Agent;
const engineer = { ...lead, id: 'ag_2', profileId: 'ap_2', name: '后端工程师', role: 'engineer', canDispatch: false } as Agent;
const department = { id: 'dep_1', companyId: 'co_1', name: '工程部', rules: {}, createdAt: '', updatedAt: '' } as Department;
const task = { id: 'tk_1', projectId: 'pr_1', projectTaskId: 'pt_1', seq: 3, title: '实现审批恢复', state: 'running', assigneeAgentId: 'ag_2', dispatcherAgentId: 'ag_1', parentTaskId: null, rootTaskId: null, assigneeThreadId: null, assigneeTaskThreadId: null, outcome: null, summary: '', question: null, inputProtocol: {}, outputProtocol: {}, contextRefs: [], artifacts: [], priority: 5, deadlineAt: null, completedAt: null, clarificationRounds: 0, isDiscussion: 0, createdAt: '', updatedAt: '' } as Task;

describe('project task-first workbench navigation', () => {
  it('renders standalone/projects/tasks sections with selected task link and tool badge (2026-08-20 UI 重构后)', () => {
    // 批3 起组件内置置顶/归档 mutation（react-query），渲染需 Provider；
    // 治理批次5：专业工具链接仅专业模式渲染——预置 systemSettings 为 pro
    const pt2 = {
      id: 'pt_1', projectId: 'pr_1', seq: 3, title: '实现审批恢复', brief: '', state: 'active',
      pinned: false, unread: true, launchState: 'confirmed', launchBrief: {} as never,
      capabilityDiscovery: null, launchConfirmedAt: null, completedAt: null, archivedAt: null,
      createdAt: '', updatedAt: '',
    } as import('../../src/client/hooks/queries').ProjectTaskDTO;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['systemSettings'], { uiMode: 'pro' });
    // 2026-08-24 结构：任务挂在项目行下——项目行来自 useProjects、行内任务来自 useProjectTasks，均需预置
    qc.setQueryData(['projects'], [{ id: 'pr_1', name: '示例项目', companyId: 'co_1', firstAgentId: 'ag_1', createdAt: '', updatedAt: '' }]);
    qc.setQueryData(['project-tasks', 'pr_1'], [pt2]);
    const pt = {
      id: 'pt_1', projectId: 'pr_1', seq: 3, title: '实现审批恢复', brief: '', state: 'active',
      pinned: false, unread: true, launchState: 'confirmed', launchBrief: {} as never,
      capabilityDiscovery: null, launchConfirmedAt: null, completedAt: null, archivedAt: null,
      createdAt: '', updatedAt: '',
    } as import('../../src/client/hooks/queries').ProjectTaskDTO;
    render(<QueryClientProvider client={qc}><MemoryRouter><ProjectWorkNavigation projectId="pr_1" projectTasks={[pt]} tasks={[task]} agents={[lead, engineer]} departments={[department]} firstAgentId="ag_1" selectedProjectTaskId="pt_1" view="task" attentionCount={2} novel={false} onNewTask={() => {}} /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByText(/独立任务/)).toBeInTheDocument();
    // 2026-08-24 定案：独立的「当前项目任务」分组退役——任务挂在项目行下（下方任务链接断言覆盖）
    expect(screen.getByText(/项目列表/)).toBeInTheDocument();
    const taskLink = screen.getByRole('link', { name: /实现审批恢复/ });
    expect(taskLink).toHaveAttribute('href', '/projects/pr_1?view=task&projectTask=pt_1');
    expect(taskLink).toHaveAttribute('aria-current', 'page');
    // 2026-08-23 定案：任务行首——运行中=转圈 logo（置顶针只在非运行时浮现）
    expect(screen.getByTitle('任务运行中')).toBeInTheDocument();
    // 「任务领取清单」在「项目工具」分类下（默认收起）——先展开再断言（2026-08-24 分类收纳）
    fireEvent.click(screen.getByRole('button', { name: /项目工具/ }));
    expect(screen.getByRole('link', { name: /任务领取清单/ })).toHaveTextContent('2');
  });

  it('keeps meaningful short marks available for project task surfaces', () => {
    expect(projectTaskMark('修复执行器审批桥')).toBe('执行');
    expect(projectTaskMark('建立任务领取清单')).toBe('任务');
  });

  it('builds employee, group, task and automation switcher destinations', () => {
    const projectItems = projectSectionOptions('pr_1', 'pt_1');
    expect(projectItems.find((item) => item.key === 'employee')?.href).toBe('/projects/pr_1?view=employee&projectTask=pt_1');
    expect(projectItems.find((item) => item.key === 'group')?.href).toBe('/projects/pr_1?view=group&projectTask=pt_1');
    expect(projectItems.find((item) => item.key === 'task')?.href).toBe('/projects/pr_1?view=task&projectTask=pt_1');
    expect(projectItems.find((item) => item.key === 'plans')?.href).toBe('/projects/pr_1/plans');
    expect(projectItems.some((item) => item.key === 'character')).toBe(false);
    expect(projectSectionOptions('pr_1', 'pt_1', true).some((item) => item.key === 'character')).toBe(true);
  });
});
