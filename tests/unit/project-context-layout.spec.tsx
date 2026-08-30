import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, Task } from '../../src/client/api/types';
import { ProjectTaskWorkspace } from '../../src/client/components/project/ProjectTaskWorkspace';
import type { ProjectTaskDTO } from '../../src/client/hooks/queries';

const agent = {
  id: 'ag_1', profileId: 'ap_1', companyId: 'co_1', name: '研发负责人', role: 'lead', responsibilities: '', systemPrompt: '', skills: [], tools: [], permissions: {}, isInspector: false, canDispatch: true, contactAllow: [], availabilityState: 'online', executor: {}, stance: '',
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
    // 2026-08-23 用户定案：任务标题条已搬到 WorkbenchShell 顶栏（ProjectPage 层渲染）——
    // 中栏组件不再含任务标题，聚焦对话流
    expect(screen.queryByText('审批恢复闭环')).not.toBeInTheDocument();
    // 批次 H.5：任务 running 中占位文案切为排队提示（原"在任务 #21 下达指令"是非运行态文案）
    expect(screen.getByPlaceholderText(/继续输入以排队后续修改…/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument();
  });
});
