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
  id: 'pt_1', projectId: 'pr_1', seq: 21, title: '审批恢复闭环', brief: '验证断线恢复', state: 'active', launchState: 'confirmed', launchBrief: { expectedOutcome: '验证断线恢复', audience: '', effectAndStyle: '', constraints: '', deliverables: ['实现审批恢复逻辑', '补齐回归测试用例'], requiredCapabilityIds: [], requiredSkillIds: [], externalResearchNeeds: [], references: [], needsVisualConfirmation: false, visualReferences: [] }, capabilityDiscovery: null, launchConfirmedAt: '', completedAt: null, archivedAt: null, createdAt: '', updatedAt: '',
  threads: [{ id: 'pth_1', employeeId: 'ag_1', executorProfileId: null, vendorSessionId: 'session_1', previousVendorSessionId: null, state: 'idle', runCount: 2, transcriptBytes: 1200, compactionCount: 1, lastCompactionAt: null, updatedAt: '' }],
};

const workOrder = {
  id: 'tk_1', projectId: 'pr_1', projectTaskId: 'pt_1', seq: 7, title: '补齐恢复测试', state: 'running', assigneeAgentId: 'ag_1', dispatcherAgentId: null, parentTaskId: null, rootTaskId: null, assigneeThreadId: null, assigneeTaskThreadId: 'pth_1', outcome: null, summary: '', question: null, inputProtocol: {}, outputProtocol: {}, contextRefs: [], artifacts: [], priority: 0, deadlineAt: null, completedAt: null, clarificationRounds: 0, isDiscussion: 0, createdAt: '', updatedAt: '',
} satisfies Task;

describe('project task workspace layout', () => {
  it('keeps the center focused on stream conversation and adaptive prompt composer', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ProjectTaskWorkspace
            projectId="pr_1"
            selectedTask={projectTask}
            tasks={[workOrder]}
            agents={[agent]}
            onSelect={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('审批恢复闭环')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/在任务 #21 中给智能体下达指令…/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument();
  });

  it('turns the inspector into an actionable team and checklist drawer panel', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ProjectContextInspector
            projectId="pr_1"
            companyId="co_1"
            projectState="active"
            selectedTask={projectTask}
            selectedAgentId="ag_1"
            agents={[agent]}
            tasks={[workOrder]}
            cockpit={{ companyId: 'co_1', companyState: 'online', employees: { total: 1, online: 0, blocked: 1 }, projects: { total: 1, active: 1, attention: 0 }, approvals: { pending: 0 }, roleGaps: [], risks: [], nextAction: { kind: '', label: '', description: '', href: '' } }}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // 2026-08-20 UI 重构：检查器 tabs = 员工信息/任务清单/产物（员工中心抽屉语义不变）
    expect(screen.getByText('👤 员工信息')).toBeInTheDocument();
    expect(screen.getByText('📋 任务清单')).toBeInTheDocument();
    expect(screen.getByText('📦 产物')).toBeInTheDocument();
  });
});
