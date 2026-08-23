/**
 * 批次 F：右栏三层信息架构（去 Tab 纵向折叠流）单测。
 *
 * 覆盖：瞬时层 attention 区、当前选中对象（员工卡/任务头卡）、折叠组默认展开规则、
 * 展开状态 localStorage 持久化（muster:inspector-collapse:<group>）、
 * 空态整组不渲染、activeTask 以 projectTaskId 关联（ID 空间错配修复回归）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Task } from '../../src/client/api/types';
import { ProjectContextInspector } from '../../src/client/components/workbench/ProjectContextInspector';
import type { ProjectTaskDTO } from '../../src/client/hooks/queries';

const mockUseUiMode = vi.fn(() => ({ uiMode: 'simple', isSimple: true, setUiMode: vi.fn(), toggle: vi.fn(), saving: false }));
const mockUseArtifacts = vi.fn(() => ({ data: [] }));
const mockUseBlueprintMatches = vi.fn(() => ({ data: [] }));
const mockUseProjectSpecialists = vi.fn(() => ({ data: [] }));
const mockUseTaskSwarm = vi.fn(() => ({ data: undefined }));
const mockUseArtifactContent = vi.fn(() => ({ data: undefined, isLoading: false }));

vi.mock('../../src/client/hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const explicit: Record<string, unknown> = {
  useUiMode: () => mockUseUiMode(),
  // 批次 I-a/I-b：右栏新租户 hook（无插件/无历史 → 组不渲染，mock 返回空态）
  usePanelPlugins: () => ({ data: [] }),
  useSideMessages: () => ({ data: [] }),
  useArtifacts: () => mockUseArtifacts(),
  useBlueprintMatches: () => mockUseBlueprintMatches(),
  useProjectSpecialists: () => mockUseProjectSpecialists(),
  useProjectHealth: () => ({ data: { projectId: 'p1', activeCount: 0, failedCount: 0, aggregateFailureCount: 0 } }),
  useTaskSwarm: () => mockUseTaskSwarm(),
  useArtifactContent: () => mockUseArtifactContent(),
  useProjectTaskAction: () => ({ mutate: vi.fn(), isPending: false }),
  useProjectDiscussions: () => ({ data: [] }),
  useCloseDiscussion: () => ({ mutate: vi.fn(), isPending: false }),
  useStartUserDiscussion: () => ({ mutate: vi.fn(), isPending: false }),
  useDiscussionDetail: () => ({ data: undefined }),

  };
  // 安全默认全覆盖（防 mock 与真实消费方脱节）：未显式 mock 的 use* hook 一律空态——
  // 新增 hook 不再因工厂漏导出而炸组件（I-a 假绿同族）
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(actual)) {
    if (typeof v === 'function' && k.startsWith('use') && !(k in explicit)) {
      safe[k] = () => ({ data: undefined, isLoading: false, isPending: false, isFetching: false, error: null, mutate: () => {}, mutateAsync: async () => {} });
    }
  }
  return { ...actual, ...safe, ...explicit };
});

import { ProjectContextInspector as Inspector } from '../../src/client/components/workbench/ProjectContextInspector';

const agent = {
  id: 'ag_1', profileId: 'ap_1', companyId: 'co_1', departmentId: null, name: '研发负责人', role: 'lead', responsibilities: '把控交付质量', systemPrompt: '', skills: ['review'], tools: [], permissions: {}, isInspector: false, canDispatch: true, contactAllow: [], availabilityState: 'online', executor: {}, stance: '',
} as Agent;

const projectTask: ProjectTaskDTO = {
  id: 'pt_1', projectId: 'pr_1', seq: 21, title: '审批恢复闭环', brief: '验证断线恢复', state: 'active', launchState: 'confirmed', launchBrief: { expectedOutcome: '验证断线恢复', audience: '', effectAndStyle: '', constraints: '', deliverables: ['实现审批恢复逻辑', '补齐回归测试用例'], requiredCapabilityIds: [], requiredSkillIds: [], externalResearchNeeds: [], references: [], needsVisualConfirmation: false, visualReferences: [] }, capabilityDiscovery: null, launchConfirmedAt: '', completedAt: null, archivedAt: null, createdAt: '', updatedAt: '',
  threads: [],
};

const workOrder = {
  id: 'tk_1', projectId: 'pr_1', projectTaskId: 'pt_1', seq: 7, title: '补齐恢复测试', state: 'running', assigneeAgentId: 'ag_1', dispatcherAgentId: null, parentTaskId: null, rootTaskId: null, assigneeThreadId: null, assigneeTaskThreadId: null, outcome: null, summary: '', question: null, inputProtocol: {}, outputProtocol: {}, contextRefs: [], artifacts: [], priority: 0, deadlineAt: null, completedAt: null, clarificationRounds: 0, isDiscussion: 0, swarmId: null, swarmDepth: 0, questionOptions: null, supersededBy: null, personaId: null, acceptanceCriteria: [{ id: 'ac_1', criterion: '恢复后状态一致', met: true }, { id: 'ac_2', criterion: '回归全绿', met: false }], createdAt: '', updatedAt: '',
} satisfies Task;

const waitingOrder = { ...workOrder, id: 'tk_2', projectTaskId: 'pt_2', state: 'waiting_input', acceptanceCriteria: [] };

function renderInspector(props: Partial<Parameters<typeof Inspector>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectContextInspector
          projectId="pr_1"
          selectedTask={projectTask}
          agents={[agent]}
          tasks={[workOrder]}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  mockUseUiMode.mockReturnValue({ uiMode: 'simple', isSimple: true, setUiMode: vi.fn(), toggle: vi.fn(), saving: false });
  mockUseArtifacts.mockReturnValue({ data: [] });
  mockUseBlueprintMatches.mockReturnValue({ data: [] });
  mockUseProjectSpecialists.mockReturnValue({ data: [] });
  mockUseTaskSwarm.mockReturnValue({ data: undefined });
  mockUseArtifactContent.mockReturnValue({ data: undefined, isLoading: false });
});

afterEach(cleanup);

describe('project context inspector（批次 F 三层信息架构）', () => {
  it('瞬时层：有待处理事项才出现「需要你关注」区', () => {
    renderInspector({ tasks: [waitingOrder] });
    expect(screen.getByText('🚨 需要你关注')).toBeInTheDocument();
  });

  it('瞬时层：无待处理事项不渲染关注区（空态不占位）', () => {
    renderInspector();
    expect(screen.queryByText('🚨 需要你关注')).not.toBeInTheDocument();
  });

  it('当前选中对象：默认渲染任务头卡（含标记完成）', () => {
    renderInspector();
    expect(screen.getByText('当前任务')).toBeInTheDocument();
    expect(screen.getByText('#21 审批恢复闭环')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '✓ 标记为完成' })).toBeInTheDocument();
  });

  it('员工视图：选中员工渲染员工卡（岗位职责+当前负责任务），任务头卡让位', () => {
    renderInspector({ selectedAgentId: 'ag_1' });
    expect(screen.getByText('📋 岗位职责')).toBeInTheDocument();
    expect(screen.getByText('⚡ 当前负责任务')).toBeInTheDocument();
    expect(screen.queryByText('当前任务')).not.toBeInTheDocument();
  });

  it('任务现场组默认展开：交付清单与验收进度直出（activeTask 以 projectTaskId 关联）', () => {
    renderInspector();
    expect(screen.getByText('任务现场')).toBeInTheDocument();
    // 验收进度来自 projectTaskId=pt_1 的工作单（修复前 t.id 对 selectedTask.id 永不命中）
    expect(screen.getByText('🔍 验收进度')).toBeInTheDocument();
    // 1/2 同时出现在组徽章与验收卡徽章（同一数据两个入口）
    expect(screen.getAllByText('1/2')).toHaveLength(2);
    expect(screen.getByText('实现审批恢复逻辑')).toBeInTheDocument();
  });

  it('空态整组不渲染：无产物数据时产物组不出现', () => {
    renderInspector();
    expect(screen.queryByText('产物')).not.toBeInTheDocument();
  });

  it('有产物时产物组渲染且默认收起，展开状态写入 localStorage', async () => {
    mockUseArtifacts.mockReturnValue({
      data: [{ id: 'a1', kind: 'doc', path: 'docs/plan.md', ownerAgentId: null, mergeStrategy: 'staging', props: {}, createdTaskId: null }],
    });
    renderInspector();
    const summary = screen.getByText('产物').closest('summary');
    expect(summary?.parentElement?.open).toBe(false);
    expect(localStorage.getItem('muster:inspector-collapse:artifacts')).toBeNull();
    fireEvent.click(summary!);
    await waitFor(() => {
      expect(localStorage.getItem('muster:inspector-collapse:artifacts')).toBe('1');
    });
    expect(summary?.parentElement?.open).toBe(true);
  });

  it('收起任务现场组会持久化，重挂载保持收起状态', async () => {
    const utils = renderInspector();
    const summary = screen.getByText('任务现场').closest('summary')!;
    expect(summary.parentElement?.open).toBe(true);
    fireEvent.click(summary);
    await waitFor(() => {
      expect(localStorage.getItem('muster:inspector-collapse:scene')).toBe('0');
    });
    utils.unmount();
    renderInspector();
    const summaryAgain = screen.getByText('任务现场').closest('summary')!;
    expect(summaryAgain.parentElement?.open).toBe(false);
  });

  it('班底与打法：专家池有数据即成组（不依赖选中任务），默认收起', () => {
    mockUseProjectSpecialists.mockReturnValue({
      data: [{ id: 'sp_1', projectId: 'pr_1', agentId: null, personaId: null, specialty: '数据库调优', tier: 'project', status: 'active', useCount: 3, createdVia: 'auto' }],
    });
    renderInspector();
    expect(screen.getByText('班底与打法')).toBeInTheDocument();
    const summary = screen.getByText('班底与打法').closest('summary')!;
    expect(summary.parentElement?.open).toBe(false);
  });

  it('批次F.3：产物条目点击在右栏打开预览（?preview= 驱动，图片走安全端点），关闭即移除', () => {
    mockUseArtifacts.mockReturnValue({
      data: [{ id: 'a1', kind: 'screenshot', path: 'shots/demo.png', ownerAgentId: null, mergeStrategy: 'staging', props: {}, createdTaskId: null }],
    });
    renderInspector();
    fireEvent.click(screen.getByTitle('右栏预览 shots/demo.png'));
    const img = screen.getByAltText('shots/demo.png') as HTMLImageElement;
    expect(img.src).toContain('/api/projects/pr_1/artifacts/preview/shots/demo.png');
    expect(screen.getByText('👁 demo.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
    expect(screen.queryByAltText('shots/demo.png')).not.toBeInTheDocument();
  });

  it('批次F.3：Markdown 预览走 content 端点渲染正文', () => {
    mockUseArtifactContent.mockReturnValue({ data: { path: 'docs/readme.md', content: '# 预览标题' }, isLoading: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/?preview=docs/readme.md']}>
          <ProjectContextInspector projectId="pr_1" agents={[agent]} tasks={[workOrder]} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('预览标题')).toBeInTheDocument();
  });
});
