import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TraceItem } from '../../src/client/api/types';

const task = { id: 'tsk_1', projectId: 'prj_1', state: 'running', title: 't' } as Task;

const items: TraceItem[] = [
  { id: 'tr_1', taskId: 'tsk_1', runId: null, seq: 3, kind: 'tool_result', name: 'read_file', summary: '读到 3 行', payload: { toolCallId: 'tc_1', content: 'a\nb\nc' }, truncated: false, occurredAt: '2026-08-15T10:03:00Z' },
  { id: 'tr_2', taskId: 'tsk_1', runId: null, seq: 2, kind: 'tool_call', name: 'read_file', summary: 'read_file({"path":"a.md"})', payload: { toolCallId: 'tc_1', arguments: { path: 'a.md' } }, truncated: false, occurredAt: '2026-08-15T10:02:00Z' },
  { id: 'tr_3', taskId: 'tsk_1', runId: null, seq: 1, kind: 'thinking', name: null, summary: '先看一下文件', payload: { text: '先看一下文件内容再决定怎么改' }, truncated: false, occurredAt: '2026-08-15T10:01:00Z' },
];

const mockUseTaskTrace = vi.fn(() => ({ data: items }));
vi.mock('../../src/client/hooks/queries', () => ({
  useTaskTrace: (...args: unknown[]) => mockUseTaskTrace(...args),
  useTaskAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { ExecutionTraceCard } from '../../src/client/components/workbench/ExecutionTraceCard';

beforeEach(() => {
  localStorage.clear();
  mockUseTaskTrace.mockReturnValue({ data: items });
});

afterEach(() => {
  cleanup();
});

describe('ExecutionTraceCard', () => {
  it('按时间倒序渲染条目，思考块默认折叠', () => {
    render(<ExecutionTraceCard task={task} />);
    expect(screen.getByText('思考')).toBeInTheDocument();
    expect(screen.queryByText('先看一下文件内容再决定怎么改')).not.toBeInTheDocument();
    expect(screen.getAllByText(/read_file/).length).toBeGreaterThan(0);
  });

  it('点击条目展开/收起详情', async () => {
    const user = userEvent.setup();
    render(<ExecutionTraceCard task={task} />);
    await user.click(screen.getByText('先看一下文件'));
    expect(screen.getByText('先看一下文件内容再决定怎么改')).toBeInTheDocument();
    await user.click(screen.getByText('先看一下文件'));
    expect(screen.queryByText('先看一下文件内容再决定怎么改')).not.toBeInTheDocument();
  });

  it('展开同类批量展开该 kind 全部条目并写入 localStorage（全局记忆）', async () => {
    const user = userEvent.setup();
    render(<ExecutionTraceCard task={task} />);
    await user.click(screen.getByRole('button', { name: /展开 思考/ }));
    expect(screen.getByText('先看一下文件内容再决定怎么改')).toBeInTheDocument();
    expect(localStorage.getItem('mu-trace-expand:thinking')).toBe('1');
  });

  it('localStorage 记忆的展开态在重新挂载后生效', async () => {
    const user = userEvent.setup();
    const first = render(<ExecutionTraceCard task={task} />);
    await user.click(screen.getByRole('button', { name: /展开 思考/ }));
    first.unmount();
    render(<ExecutionTraceCard task={task} />);
    expect(screen.getByText('先看一下文件内容再决定怎么改')).toBeInTheDocument();
  });

  it('空数据渲染空态', () => {
    mockUseTaskTrace.mockReturnValue({ data: [] });
    render(<ExecutionTraceCard task={task} />);
    expect(screen.getByText(/还没有执行过程/)).toBeInTheDocument();
  });

  it('preview 条目渲染缩略图', () => {
    mockUseTaskTrace.mockReturnValue({
      data: [{ id: 'tr_4', taskId: 'tsk_1', runId: null, seq: 4, kind: 'preview', name: null, summary: 'posters/v2.png', payload: { path: 'posters/v2.png' }, truncated: false, occurredAt: '2026-08-15T10:04:00Z' }],
    });
    render(<ExecutionTraceCard task={task} />);
    expect(screen.getByAltText('posters/v2.png')).toHaveAttribute('src', '/api/projects/prj_1/artifacts/raw?path=posters%2Fv2.png');
  });
});
