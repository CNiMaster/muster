import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../src/client/api/types';

const task = {
  id: 'tsk_1', projectId: 'prj_1', seq: 1, title: '测试任务', state: 'completed',
  summary: '完成', question: null, inputProtocol: {}, outputProtocol: {}, contextRefs: [],
  artifacts: [], priority: 5, deadlineAt: null, completedAt: null, clarificationRounds: 0,
  isDiscussion: 0, swarmId: 'sw_1', swarmDepth: 1, questionOptions: null,
  supersededBy: 'tsk_9',
  assigneeAgentId: 'ag_1', dispatcherAgentId: 'ag_2', parentTaskId: null, rootTaskId: null,
  assigneeThreadId: null, assigneeTaskThreadId: null, outcome: 'completed',
  createdAt: '2026-08-15T00:00:00Z', updatedAt: '2026-08-15T00:00:00Z', projectTaskId: '',
} as Task;

vi.mock('../../src/client/hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const explicit: Record<string, unknown> = {
  useTask: () => ({ data: task }),
  useProject: () => ({ data: { id: 'prj_1', companyId: 'co_1', name: 'novel' } }),
  useAgents: () => ({ data: [] }),
  useTaskEvents: () => ({ data: [] }),
  useTaskMessages: () => ({ data: [] }),
  usePostTaskMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useTaskAction: () => ({ mutate: vi.fn(), isPending: false }),
  useTaskSwarm: () => ({ data: { swarm: { id: 'sw_1', goal: 'g', status: 'active', nodesTotal: 2, nodesDone: 1, nodesFailed: 1, maxDepth: 3, maxWidth: 5, maxNodes: 30, budgetUsd: 5, createdAt: '', finishedAt: null }, tasks: [task, { ...task, id: 'tsk_9', seq: 9, title: '[替补] 测试任务', supersededBy: null }] } }),
  useAbortSwarm: () => ({ mutate: vi.fn(), isPending: false }),
  usePersonas: () => ({ data: [] }),
  useTaskTrace: () => ({ data: [] }),
  useTaskCloseout: () => ({ data: undefined, isLoading: false }),
  useGenerateTaskCloseout: () => ({ mutate: vi.fn(), isPending: false }),

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

import { TaskDetailPage } from '../../src/client/pages/TaskDetailPage';

afterEach(() => {
  cleanup();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tasks/tsk_1']}>
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TaskDetailPage 执行过程集成', () => {
  it('主列渲染「执行过程」卡片', () => {
    renderPage();
    expect(screen.getByText('执行过程')).toBeInTheDocument();
    expect(screen.getByText('还没有执行过程')).toBeInTheDocument();
  });

  it('蜂群树对失败蜂渲染「已重发」链接', () => {
    renderPage();
    expect(screen.getByRole('link', { name: /已重发/ })).toHaveAttribute('href', '/tasks/tsk_9');
  });
});
