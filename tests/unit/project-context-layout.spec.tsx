import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, Task } from '../../src/client/api/types';
import { ProjectTaskWorkspace } from '../../src/client/components/project/ProjectTaskWorkspace';
import { ProjectContextInspector } from '../../src/client/components/workbench/ProjectContextInspector';
import type { ProjectTaskDTO } from '../../src/client/hooks/queries';

const agent = {
  id: 'ag_1', profileId: 'ap_1', companyId: 'co_1', departmentId: null, name: '研发负责人', role: 'lead', responsibilities: '', systemPrompt: '', skills: [], tools: [], permissions: {}, isInspector: false, canDispatch: true, contactAllow: [], availabilityState: 'online', executor: {}, stance: '',
} as Agent;

const projectTask: ProjectTaskDTO = {
  id: 'pt_1', projectId: 'pr_1', seq: 21, title: '审批恢复闭环', brief: '验证断线恢复', state: 'active', launchState: 'confirmed', launchBrief: { expectedOutcome: '验证断线恢复', audience: '', effectAndStyle: '', constraints: '', deliverables: [], requiredCapabilityIds: [], requiredSkillIds: [], externalResearchNeeds: [], references: [], needsVisualConfirmation: false, visualReferences: [] }, capabilityDiscovery: null, launchConfirmedAt: '', completedAt: null, archivedAt: null, createdAt: '', updatedAt: '',
  threads: [{ id: 'pth_1', employeeId: 'ag_1', executorProfileId: null, vendorSessionId: 'session_1', previousVendorSessionId: null, state: 'idle', runCount: 2, transcriptBytes: 1200, compactionCount: 1, lastCompactionAt: null, updatedAt: '' }],
};

const workOrder = {
  id: 'tk_1', projectId: 'pr_1', projectTaskId: 'pt_1', seq: 7, title: '补齐恢复测试', state: 'running', assigneeAgentId: 'ag_1', dispatcherAgentId: null, parentTaskId: null, rootTaskId: null, assigneeThreadId: null, assigneeTaskThreadId: 'pth_1', outcome: null, summary: '', question: null, inputProtocol: {}, outputProtocol: {}, contextRefs: [], artifacts: [], priority: 0, deadlineAt: null, completedAt: null, clarificationRounds: 0, isDiscussion: 0, createdAt: '', updatedAt: '',
} satisfies Task;

describe('project task workspace layout', () => {
  it('keeps the center focused on one project task and one dispatch composer', () => {
    render(<ProjectTaskWorkspace selectedTask={projectTask} tasks={[projectTask]} agents={[agent]} draft={{ title: '', brief: '' }} creating={false} onDraftChange={vi.fn()} onCreate={vi.fn()} onSelect={vi.fn()} onComplete={vi.fn()} onArchive={vi.fn()} workOrder={{ title: '', assigneeId: '' }} onWorkOrderChange={vi.fn()} onPublishWorkOrder={vi.fn()} discoveringLaunch={false} confirmingLaunch={false} onDiscoverLaunch={vi.fn()} onConfirmLaunch={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '审批恢复闭环', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '工作内容' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '派发工作单' })).toBeDisabled();
    expect(screen.getByText('开始一段新的工作上下文')).toBeInTheDocument();
    expect(screen.queryByText('最近发布的任务')).not.toBeInTheDocument();
  });

  it('turns the inspector into an actionable task panel', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><ProjectContextInspector projectId="pr_1" companyId="co_1" projectState="active" selectedTask={projectTask} selectedAgentId="ag_1" agents={[agent]} tasks={[workOrder]} cockpit={{ companyId: 'co_1', companyState: 'online', employees: { total: 1, online: 0, blocked: 1 }, projects: { total: 1, active: 1, attention: 0 }, approvals: { pending: 0 }, roleGaps: [], risks: [], nextAction: { kind: '', label: '', description: '', href: '' } }} /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole('link', { name: '派发给此员工' })).toHaveAttribute('href', '#employee-dispatch');
    expect(screen.getByRole('link', { name: /补齐恢复测试/ })).toHaveAttribute('href', '/tasks/tk_1');
    expect(screen.getByRole('link', { name: /自动计划/ })).toHaveAttribute('href', '/projects/pr_1/plans');
    expect(screen.getByRole('link', { name: '员工引用关系' })).toHaveAttribute('href', '/companies/co_1/graphs/communication');
  });

  it('shows requirement and capability confirmation before exposing production dispatch', () => {
    const draftTask: ProjectTaskDTO = { ...projectTask, launchState: 'draft', launchConfirmedAt: null, launchBrief: { ...projectTask.launchBrief, expectedOutcome: '', needsVisualConfirmation: true, visualReferences: [] } };
    const { container } = render(<ProjectTaskWorkspace selectedTask={draftTask} tasks={[draftTask]} agents={[agent]} draft={{ title: '', brief: '' }} creating={false} onDraftChange={vi.fn()} onCreate={vi.fn()} onSelect={vi.fn()} onComplete={vi.fn()} onArchive={vi.fn()} workOrder={{ title: '', assigneeId: '' }} onWorkOrderChange={vi.fn()} onPublishWorkOrder={vi.fn()} discoveringLaunch={false} confirmingLaunch={false} onDiscoverLaunch={vi.fn()} onConfirmLaunch={vi.fn()} />);
    expect(screen.getByText('先确认想要的效果与可执行能力')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认需求与能力方案，允许制作' })).toBeDisabled();
    expect(screen.getByText('制作尚未开始')).toBeInTheDocument();
    expect(container.querySelector('.work-order-composer-heading')).toBeNull();
  });
});
