/**
 * 批次 H.2：工作胶囊 + 工作现场面板——有事才出现、展开挂 ?panel=live。
 * 计划活文档 S3：四分区两层看板（Git 工具/计划/进程/智能体）+ 聚焦 tab 条 + todo 三态明细。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../src/client/api/types';

const mockHealth = vi.fn(() => ({ data: undefined }));
const mockDispatchTree = vi.fn(() => ({ data: undefined }));
const mockTaskOnce = vi.fn(() => ({ data: undefined }));
const mockTaskTodo = vi.fn(() => ({ data: undefined }));
const mockTaskPlanFile = vi.fn(() => ({ data: undefined }));
const mockPlanVersions = vi.fn(() => ({ data: undefined }));
const mockRoundChanges = vi.fn(() => ({ data: undefined }));

vi.mock('../../src/client/hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/hooks/queries')>();
  return {
    ...actual,
    useProjectHealth: () => mockHealth(),
    useDispatchTree: () => mockDispatchTree(),
    useTaskOnce: () => mockTaskOnce(),
    useTaskTodo: (taskId: unknown) => mockTaskTodo(taskId),
    useTaskPlanFile: () => mockTaskPlanFile(),
    usePlanVersions: () => mockPlanVersions(),
    useRoundChanges: () => mockRoundChanges(),
  };
});

import { WorkCapsule } from '../../src/client/components/workbench/WorkCapsule';
import { WorkLivePanel, TodoDetail } from '../../src/client/components/workbench/WorkLivePanel';

function makeTask(id: string, state: string, overrides: Partial<Task> = {}): Task {
  return {
    id, projectId: 'pr_1', projectTaskId: 'pt_1', seq: 1, title: `任务${id}`, state,
    assigneeAgentId: null, dispatcherAgentId: null, parentTaskId: null, rootTaskId: null,
    assigneeThreadId: null, assigneeTaskThreadId: null, outcome: null, summary: '', question: null,
    inputProtocol: {}, outputProtocol: {}, contextRefs: [], artifacts: [], priority: 5,
    deadlineAt: null, completedAt: null, clarificationRounds: 0, isDiscussion: 0,
    swarmId: null, swarmDepth: 0, questionOptions: null, acceptanceCriteria: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function qc(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('WorkCapsule（批次 H.2）', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('无活跃且无失败时不出现；有运行任务显示一句话摘要', () => {
    const { rerender } = render(
      <QueryClientProvider client={qc()}><MemoryRouter>
        <WorkCapsule projectId="pr_1" tasks={[]} agents={[]} />
      </MemoryRouter></QueryClientProvider>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(
      <QueryClientProvider client={qc()}><MemoryRouter>
        <WorkCapsule projectId="pr_1" tasks={[makeTask('t1', 'running', { assigneeAgentId: 'ag_1' })]} agents={[{ id: 'ag_1', name: '张三' } as never]} />
      </MemoryRouter></QueryClientProvider>,
    );
    expect(screen.getByText(/张三正在/)).toBeInTheDocument();
  });

  it('2026-08-28 定案：点击=原地弹出悬浮看板（不再写右栏 plan 标签）；再点收起', () => {
    // MemoryRouter 不动 window.location——用探针组件读路由状态
    let searchNow = '';
    function Probe(): null {
      const [sp] = useSearchParams();
      searchNow = sp.toString();
      return null;
    }
    render(
      <QueryClientProvider client={qc()}><MemoryRouter initialEntries={['/projects/pr_1?view=task']}>
        <Probe />
        <WorkCapsule projectId="pr_1" tasks={[makeTask('t1', 'running')]} agents={[]} />
      </MemoryRouter></QueryClientProvider>,
    );
    const capsule = screen.getByRole('button', { name: /团队正在/ });
    fireEvent.click(capsule);
    // 悬浮看板原地出现（四分区），URL 不写 rt=plan:live
    expect(screen.getAllByText(/Git 工具/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/进程/).length).toBeGreaterThanOrEqual(1);
    expect(searchNow).not.toContain('plan%3Alive');
    // 再点胶囊收起
    fireEvent.click(screen.getByRole('button', { name: /团队正在/ }));
    expect(screen.queryByText(/Git 工具/)).not.toBeInTheDocument();
  });
});

describe('WorkLivePanel（计划活文档 S3：四分区两层看板）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 折叠组展开状态按 localStorage 持久化——用例间必须清（lazy 化后上例的展开态会翻转下例的点击语义）
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('muster:inspector-collapse:')) localStorage.removeItem(k);
      }
    } catch { /* 存储不可用时按默认态跑 */ }
    mockDispatchTree.mockReturnValue({
      data: {
        progress: { done: 1, total: 2 },
        tasks: [
          { id: 'n1', seq: 1, title: '[用户消息] 做A', state: 'completed', parentTaskId: null, swarmId: null, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 60000, assignee: { id: 'ag_1', name: '张三', kind: 'employee' }, dispatcher: { id: 'ag_lead', name: '负责人' }, todo: { done: 2, total: 3, current: null } },
          { id: 'n2', seq: 2, title: '子题A', state: 'running', parentTaskId: null, swarmId: 'sw_1', createdAt: new Date().toISOString(), completedAt: null, durationMs: 120000, assignee: { id: 'ag_bee', name: '工蜂-1', kind: 'bee' }, dispatcher: { id: 'ag_lead', name: '负责人' }, todo: { done: 0, total: 0, current: null } },
        ],
      },
    });
    mockTaskTodo.mockImplementation((taskId: unknown) => ({
      data: taskId === 'n1'
        ? {
            taskId: 'n1', done: 1, total: 3,
            items: [
              { content: '已完成步骤', status: 'done' as const },
              { content: '正在做的步骤', status: 'in_progress' as const },
              { content: '待办步骤', status: 'pending' as const },
            ],
            assignee: null,
          }
        : undefined,
    }));
  });
  afterEach(cleanup);

  it('四分区渲染：Git 工具/计划/进程 1/2/智能体；进程按执行者分组（组头 todo 汇总）', async () => {
    render(<QueryClientProvider client={qc()}><MemoryRouter><WorkLivePanel projectId="pr_1" /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByText('Git 工具')).toBeInTheDocument();
    expect(screen.getByText('计划')).toBeInTheDocument();
    // 头部徽标与进程分区标题都显示 done/total——按计数断言
    expect(screen.getAllByText(/进程 1\/2/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/智能体/)).toBeInTheDocument();
    // 执行者分组组头：张三的执行清单 2/3（todo 汇总）、工蜂-1 的执行清单 0/0
    expect(screen.getByText('张三的执行清单 2/3')).toBeInTheDocument();
    expect(screen.getByText('工蜂-1的执行清单 0/0')).toBeInTheDocument();
    // 智能体分区内执行者目录保留：任务行 + 派遣分组（lazy 组——点开后异步渲染，findBy 等待）
    fireEvent.click(screen.getByText(/智能体/));
    expect(await screen.findByText('负责人 派了 ↓')).toBeInTheDocument();
    expect(screen.getByText(/张三 · 做A/)).toBeInTheDocument();
    expect(screen.getByText(/工蜂-1 · 子题A/)).toBeInTheDocument();
  });

  it('进程组内 todo 三态明细：已完成折叠/当前高亮/待处理折叠（jsdom toggle 异步，直渲染验证）', () => {
    mockTaskTodo.mockImplementation((taskId: unknown) => ({
      data: taskId === 'n1'
        ? {
            taskId: 'n1', done: 1, total: 3,
            items: [
              { content: '已完成步骤', status: 'done' as const },
              { content: '正在做的步骤', status: 'in_progress' as const },
              { content: '待办步骤', status: 'pending' as const },
            ],
            assignee: null,
          }
        : undefined,
    }));
    render(
      <QueryClientProvider client={qc()}><MemoryRouter>
        <TodoDetail taskId="n1" />
      </MemoryRouter></QueryClientProvider>,
    );
    expect(screen.getByText('已完成 1 项')).toBeInTheDocument();
    expect(screen.getByText('→ 正在做的步骤')).toBeInTheDocument();
    expect(screen.getByText('待处理 1 项')).toBeInTheDocument();
    // 空清单不渲染任何占位
    cleanup();
    render(
      <QueryClientProvider client={qc()}><MemoryRouter>
        <TodoDetail taskId="n2" />
      </MemoryRouter></QueryClientProvider>,
    );
    expect(screen.queryByText(/待处理/)).not.toBeInTheDocument();
  });

  it('聚焦 tab 条：全部 + 各执行者；点击聚焦后只看该执行者；「全部」可解除（R1 三态）', async () => {
    render(<QueryClientProvider client={qc()}><MemoryRouter><WorkLivePanel projectId="pr_1" /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole('button', { name: '全部' })).toBeInTheDocument();
    fireEvent.click(screen.getByText(/智能体/));
    await screen.findByText(/工蜂-1 · 子题A/);
    fireEvent.click(screen.getByRole('button', { name: '张三' }));
    // 聚焦张三后：工蜂-1 的任务行消失（进程与智能体两分区都过滤；lazy 重渲染异步，findBy 等待）
    expect(await screen.findByText(/张三 · 做A/)).toBeInTheDocument();
    expect(screen.queryByText(/工蜂-1 · 子题A/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(await screen.findByText(/工蜂-1 · 子题A/)).toBeInTheDocument();
  });

  it('智能体分区：视角切换到任务扁平后不再显示派遣分组标题', async () => {
    render(<QueryClientProvider client={qc()}><MemoryRouter><WorkLivePanel projectId="pr_1" /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(screen.getByText(/智能体/)); // 展开分区（lazy 异步渲染）
    fireEvent.click(await screen.findByRole('button', { name: '切到任务扁平' }));
    expect(screen.queryByText('负责人 派了 ↓')).not.toBeInTheDocument();
  });

  it('点击执行者进入二级看板（useTaskOnce + 返回）', async () => {
    mockTaskOnce.mockReturnValue({ data: makeTask('n2', 'running') });
    render(<QueryClientProvider client={qc()}><MemoryRouter><WorkLivePanel projectId="pr_1" /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(screen.getByText(/智能体/));
    fireEvent.click(await screen.findByRole('button', { name: /工蜂-1 · 子题A/ }));
    expect(await screen.findByRole('button', { name: '← 返回目录' })).toBeInTheDocument();
    // 返回：二级分支卸载（目录渲染已由四分区/聚焦用例覆盖——此处断言不依赖 jsdom 双挂时序窗口）
    fireEvent.click(screen.getByRole('button', { name: '← 返回目录' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '← 返回目录' })).not.toBeInTheDocument());
  });

  it('计划分区：激活计划版本行 + 无计划文件占位', async () => {
    mockPlanVersions.mockReturnValue({ data: { ok: true, versions: [], active: { id: 'pv1', projectId: 'pr_1', version: 3, parentVersion: null, specRef: null, planDocRef: '/x.md', createdBy: null, createdReason: null, status: 'active', createdAt: '', updatedAt: '' } } });
    render(<QueryClientProvider client={qc()}><MemoryRouter><WorkLivePanel projectId="pr_1" /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(screen.getByText('计划'));
    expect(await screen.findByText('激活计划 v3 · 有文档')).toBeInTheDocument();
    expect(screen.getByText('计划页 ↗')).toBeInTheDocument();
    expect(screen.getByText(/暂无计划文件/)).toBeInTheDocument();
  });
});
