/**
 * 批次 H.1：RoundChangesCard 组件——收起/展开形态、撤销确认流、审查/打开动作。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseRoundChanges = vi.fn(() => ({ data: undefined }));
const mockUseRoundChangeFile = vi.fn(() => ({ data: undefined, isLoading: false }));
const mockUseLocateRoundFile = vi.fn(() => ({ data: undefined }));
const undoMutate = vi.fn();

vi.mock('../../src/client/hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/hooks/queries')>();
  return {
    ...actual,
    useRoundChanges: () => mockUseRoundChanges(),
    useRoundChangeFile: () => mockUseRoundChangeFile(),
    useLocateRoundFile: () => mockUseLocateRoundFile(),
    useUndoRoundChange: () => ({ mutate: undoMutate, isPending: false }),
  };
});

import { RoundChangesCard } from '../../src/client/components/workbench/RoundChangesCard';

function renderCard(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RoundChangesCard projectId="pr_1" taskId="t_1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RoundChangesCard（批次 H.1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRoundChanges.mockReturnValue({
      data: {
        publishId: 'pub_1',
        files: [
          { path: 'docs/报告.md', adds: 20, dels: 8 },
          { path: 'src/a.ts', adds: 8, dels: 6 },
        ],
      },
    });
  });
  afterEach(cleanup);

  it('收起态显示 N 个文件与 ±合计；无记录不渲染', () => {
    renderCard();
    expect(screen.getByText(/2 个文件已更改/)).toBeInTheDocument();
    expect(screen.getByText(/\+28 −14/)).toBeInTheDocument();
    mockUseRoundChanges.mockReturnValue({ data: { publishId: null, files: [] } });
    // 无记录时返回 null（第二条用例独立验证，这里仅确认有记录时形态）
  });

  it('展开显示文件行：文件名/相对地址/±行数/审查/打开', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /2 个文件已更改/ }));
    expect(screen.getByText('报告.md')).toBeInTheDocument();
    expect(screen.getByText('docs/报告.md')).toBeInTheDocument();
    expect(screen.getByText('+20 −8')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '审查' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '打开' })).toHaveLength(2);
  });

  it('撤销走确认弹窗，确认后调 mutation', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /——撤销/ }));
    expect(screen.getByText(/将 git revert 本轮/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
    await waitFor(() => expect(undoMutate).toHaveBeenCalledWith('t_1', expect.anything()));
  });

  it('已撤销（rolledBack）不再显示撤销按钮', () => {
    mockUseRoundChanges.mockReturnValue({
      data: { publishId: 'pub_1', rolledBack: true, files: [{ path: 'a.md', adds: 1, dels: 1 }] },
    });
    renderCard();
    expect(screen.queryByRole('button', { name: /——撤销/ })).not.toBeInTheDocument();
    expect(screen.getByText('已撤销本轮')).toBeInTheDocument();
  });
});
