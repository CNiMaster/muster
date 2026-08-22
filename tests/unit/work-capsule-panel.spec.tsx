/**
 * 批次 H.2：工作胶囊 + 工作现场面板——有事才出现、展开挂 ?panel=live、三段渲染与视角切换。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../src/client/api/types';

const mockHealth = vi.fn(() => ({ data: undefined }));
const mockDispatchTree = vi.fn(() => ({ data: undefined }));
const mockProjectTasks = vi.fn(() => ({ data: [] }));
const mockTaskOnce = vi.fn(() => ({ data: undefined }));

vi.mock('../../src/client/hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/hooks/queries')>();
  return {
    ...actual,
    useProjectHealth: () => mockHealth(),
    useDispatchTree: () => mockDispatchTree(),
    useProjectTasks: () => mockProjectTasks(),
    useTaskOnce: () => mockTaskOnce(),
  };
});

import { WorkCapsule } from '../../src/client/components/workbench/WorkCapsule';
import { WorkLivePanel } from '../../src/client/components/workbench/WorkLivePanel';

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

  it('点击展开写入 ?panel=live；再点收起移除', () => {
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
    fireEvent.click(screen.getByRole('button'));
    expect(searchNow).toContain('panel=live');
    fireEvent.click(screen.getByRole('button'));
    expect(searchNow).not.toContain('panel=live');
  });
});

describe('WorkLivePanel（批次 H.2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectTasks.mockReturnValue({ data: [{ id: 'pt_1', seq: 1, title: '主线任务', brief: '目标一句话' }] });
    mockDispatchTree.mockReturnValue({
      data: {
        progress: { done: 1, total: 2 },
        tasks: [
          { id: 'n1', seq: 1, title: '[用户消息] 做A', state: 'completed', parentTaskId: null, swarmId: null, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 60000, assignee: { id: 'ag_1', name: '张三', kind: 'employee' }, dispatcher: { id: 'ag_lead', name: '负责人' } },
          { id: 'n2', seq: 2, title: '子题A', state: 'running', parentTaskId: null, swarmId: 'sw_1', createdAt: new Date().toISOString(), completedAt: null, durationMs: 120000, assignee: { id: 'ag_bee', name: '工蜂-1', kind: 'bee' }, dispatcher: { id: 'ag_lead', name: '负责人' } },
        ],
      },
    });
  });
  afterEach(cleanup);

  it('三段渲染：计划条目/进程 1/2/派遣树分组（谁派谁）', () => {
    render(<QueryClientProvider client={qc()}><MemoryRouter><WorkLivePanel projectId="pr_1" /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole('button', { name: /主线任务/ })).toBeInTheDocument();
    // 头部徽标与进程段标题都显示 done/total——按计数断言
    expect(screen.getAllByText(/进程 1\/2/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('负责人 派了 ↓')).toBeInTheDocument();
    expect(screen.getByText(/张三 · 做A/)).toBeInTheDocument();
    expect(screen.getByText(/工蜂-1 · 子题A/)).toBeInTheDocument();
    // 执行者行内雇佣标签 + 底部图例都出现「工蜂」——按计数断言
    expect(screen.getAllByText('工蜂').length).toBeGreaterThanOrEqual(2);
  });

  it('视角切换到任务扁平：不再显示派遣分组标题', () => {
    render(<QueryClientProvider client={qc()}><MemoryRouter><WorkLivePanel projectId="pr_1" /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: '切到任务扁平' }));
    expect(screen.queryByText('负责人 派了 ↓')).not.toBeInTheDocument();
    expect(screen.getByText(/工蜂-1 · 子题A/)).toBeInTheDocument();
  });

  it('点击执行者进入二级看板（useTaskOnce + 返回）', () => {
    mockTaskOnce.mockReturnValue({ data: makeTask('n2', 'running') });
    render(<QueryClientProvider client={qc()}><MemoryRouter><WorkLivePanel projectId="pr_1" /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: /工蜂-1 · 子题A/ }));
    expect(screen.getByRole('button', { name: '← 返回目录' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '← 返回目录' }));
    expect(screen.getByText('负责人 派了 ↓')).toBeInTheDocument();
  });
});
