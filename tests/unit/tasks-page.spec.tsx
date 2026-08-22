/**
 * 批次 G.4：任务栏分组折叠 + 排序 + 显示全部。
 * 覆盖：列折叠持久化（muster:tasks-page:v1）、排序三口径切换并持久化、>10 条时显示全部。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Task } from '../../src/client/api/types';
import { TasksPage } from '../../src/client/pages/TasksPage';

const AGENTS: Agent[] = [
  { id: 'ag_1', name: '林晚晴', role: '第一负责人' } as Agent,
  { id: 'ag_2', name: '沈逸', role: '专家' } as Agent,
];

function makeTask(id: string, seq: number, overrides: Partial<Task> = {}): Task {
  const base = new Date('2026-08-20T10:00:00Z').getTime();
  return {
    id, seq, title: `任务${seq}`, state: 'queued',
    assigneeAgentId: 'ag_1', projectId: 'pr_1',
    createdAt: new Date(base + seq * 1000).toISOString(),
    updatedAt: new Date(base + seq * 60_000).toISOString(),
    ...overrides,
  } as Task;
}

let tasksData: Task[] = [];

vi.mock('../../src/client/hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/hooks/queries')>();
  return {
    ...actual,
    useProject: () => ({ data: { id: 'pr_1', name: '项目一' } }),
    useTasks: () => ({ data: tasksData }),
    useProjectTasks: () => ({ data: [] }),
    useAgents: () => ({ data: AGENTS }),
    useCreateTask: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/projects/pr_1/tasks']}>
      <Routes>
        <Route path="/projects/:projectId/tasks" element={<TasksPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TasksPage 分组折叠与排序（批次 G.4）', () => {
  beforeEach(() => {
    localStorage.clear();
    tasksData = [
      makeTask('t_1', 1),
      makeTask('t_2', 2, { assigneeAgentId: 'ag_2' }),
      makeTask('t_3', 3),
    ];
  });
  afterEach(cleanup);

  it('列折叠写入 muster:tasks-page:v1 并隐藏任务卡', () => {
    renderPage();
    expect(screen.getByText('任务3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '收起 林晚晴 的任务栏' }));
    expect(screen.queryByText('任务3')).not.toBeInTheDocument();
    expect(screen.getByText('任务2')).toBeInTheDocument(); // 其他列不受影响
    const prefs = JSON.parse(localStorage.getItem('muster:tasks-page:v1') ?? '{}');
    expect(prefs.collapsed).toEqual(['ag_1']);
    // 再展开可复位
    fireEvent.click(screen.getByRole('button', { name: '展开 林晚晴 的任务栏' }));
    expect(screen.getByText('任务3')).toBeInTheDocument();
  });

  it('排序切换：最近创建与 #seq 倒序的列内顺序不同，且选择持久化', () => {
    tasksData = [
      makeTask('t_1', 1, { createdAt: '2026-08-22T09:00:00Z' }), // seq 小但最新创建
      makeTask('t_2', 2, { createdAt: '2026-08-21T09:00:00Z' }),
      makeTask('t_3', 3, { createdAt: '2026-08-20T09:00:00Z' }),
    ];
    renderPage();
    const column = () => screen.getAllByText(/任务\d/).map((el) => el.textContent);
    // 默认 #seq 倒序：3 → 2 → 1
    expect(column()).toEqual(['任务3', '任务2', '任务1']);
    fireEvent.change(screen.getByLabelText('任务排序'), { target: { value: 'created' } });
    // 最近创建：1 → 2 → 3
    expect(column()).toEqual(['任务1', '任务2', '任务3']);
    expect(JSON.parse(localStorage.getItem('muster:tasks-page:v1') ?? '{}').sort).toBe('created');
  });

  it('超过 10 条：默认截断 + 显示全部/收起全部', () => {
    tasksData = Array.from({ length: 12 }, (_, i) => makeTask(`t_${i}`, i + 1));
    renderPage();
    const column = screen.getAllByRole('link').filter((el) => /任务\d+/.test(el.textContent ?? ''));
    expect(column).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: /显示全部 12 条/ }));
    expect(screen.getAllByRole('link').filter((el) => /任务\d+/.test(el.textContent ?? ''))).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: '收起全部' }));
    expect(screen.getAllByRole('link').filter((el) => /任务\d+/.test(el.textContent ?? ''))).toHaveLength(10);
  });

  it('等待负责人分配栏同样可折叠', () => {
    tasksData = [makeTask('t_pool', 9, { assigneeAgentId: null, title: '池中任务' })];
    renderPage();
    expect(screen.getByText('池中任务')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '收起等待分配栏' }));
    expect(screen.queryByText('池中任务')).not.toBeInTheDocument();
  });
});
