/**
 * 批次 G.3：记忆面板多维过滤——cause 下拉 / tag chips 多选（OR 语义）/ 项目维度筛选+项目徽章。
 * 沿用面板既有客户端过滤模式（scope 同款），无服务端改动。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryCandidate, MemoryEntry, Project } from '../../src/client/api/types';
import { MemoryReviewPanel } from '../../src/client/components/MemoryReviewPanel';

let entriesData: MemoryEntry[] = [];

vi.mock('../../src/client/hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/hooks/queries')>();
  return {
    ...actual,
    useMemoryCandidates: () => ({ data: [] as MemoryCandidate[] }),
    useMemoryEntries: () => ({ data: entriesData }),
    useProjects: () => ({
      data: [
        { id: 'pr_a', name: '小说工坊' },
        { id: 'pr_b', name: '官网改版' },
      ] as Project[],
    }),
    useReviewMemoryCandidate: () => ({ mutate: vi.fn(), isPending: false }),
    useMemoryEntryAction: () => ({ mutate: vi.fn(), isPending: false }),
    useCorrectMemoryEntry: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'me_' + Math.random().toString(36).slice(2, 8),
    profileId: 'pf_1',
    scope: 'personal',
    projectId: null,
    content: '内容-' + Math.random().toString(36).slice(2, 6),
    version: 1,
    state: 'active',
    canInfluence: true,
    sourceCandidateId: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('MemoryReviewPanel 多维过滤（批次 G.3）', () => {
  beforeEach(() => {
    entriesData = [
      makeEntry({ id: 'me_a', content: 'A-模型归因-写作项目', cause: 'model', tags: ['写作', '节奏'], projectId: 'pr_a' }),
      makeEntry({ id: 'me_b', content: 'B-方法归因-官网项目', cause: 'method', tags: ['前端'], projectId: 'pr_b' }),
      makeEntry({ id: 'me_c', content: 'C-未归因-无项目', tags: ['写作'] }),
    ];
  });
  afterEach(cleanup);

  it('初始渲染全部三条 + 项目徽章显示项目名', () => {
    render(<MemoryReviewPanel profileId="pf_1" />);
    expect(screen.getByText('已批准记忆 3')).toBeInTheDocument();
    // 项目名同时出现在过滤下拉 option 与条目徽章，按计数断言
    expect(screen.getAllByText('小说工坊').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('官网改版').length).toBeGreaterThanOrEqual(1);
  });

  it('cause 下拉过滤：选归因·模型只剩 A', () => {
    render(<MemoryReviewPanel profileId="pf_1" />);
    fireEvent.change(screen.getByLabelText('归因过滤'), { target: { value: 'model' } });
    expect(screen.getByText('已批准记忆 1')).toBeInTheDocument();
    expect(screen.getByText('A-模型归因-写作项目')).toBeInTheDocument();
    expect(screen.queryByText('B-方法归因-官网项目')).not.toBeInTheDocument();
  });

  it('tag chips 多选 OR 语义：选 #前端+#节奏 命中 A/B，不命中纯 #写作 的 C', () => {
    render(<MemoryReviewPanel profileId="pf_1" />);
    // 过滤 chip 是 button，与条目内同名 tag span 区分
    fireEvent.click(screen.getByRole('button', { name: '#前端' }));
    fireEvent.click(screen.getByRole('button', { name: '#节奏' }));
    expect(screen.getByText('已批准记忆 2')).toBeInTheDocument();
    expect(screen.getByText('A-模型归因-写作项目')).toBeInTheDocument();
    expect(screen.getByText('B-方法归因-官网项目')).toBeInTheDocument();
    expect(screen.queryByText('C-未归因-无项目')).not.toBeInTheDocument();
  });

  it('项目下拉过滤 + 清除过滤复位', () => {
    render(<MemoryReviewPanel profileId="pf_1" />);
    fireEvent.change(screen.getByLabelText('项目过滤'), { target: { value: 'pr_b' } });
    expect(screen.getByText('已批准记忆 1')).toBeInTheDocument();
    expect(screen.getByText('B-方法归因-官网项目')).toBeInTheDocument();
    fireEvent.click(screen.getByText('清除过滤'));
    expect(screen.getByText('已批准记忆 3')).toBeInTheDocument();
  });
});
