/**
 * 批次 H.6/H.7：划选上下文（引用条+前缀注入）、消息复制角标、终端折条判别。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptComposer } from '../../src/client/components/workbench/PromptComposer';

function renderComposer(props: Partial<Parameters<typeof PromptComposer>[0]> = {}): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <PromptComposer onSend={() => {}} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PromptComposer 划选引用（批次 H.6）', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(cleanup);

  it('quotedContext 显示引用条可移除；发送时前缀注入 "> 引用：…"', () => {
    const sent: string[] = [];
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <PromptComposer quotedContext="上一轮的方案描述" onClearQuoted={() => {}} onSend={(c) => sent.push(c)} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/上一轮的方案描述/)).toBeInTheDocument();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '照这个做' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sent[0]).toContain('> 引用：上一轮的方案描述');
    expect(sent[0]).toContain('照这个做');
    // 引用条可移除
    fireEvent.click(screen.getByRole('button', { name: '移除引用' }));
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <PromptComposer onSend={(c) => sent.push(c)} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/上一轮的方案描述/)).not.toBeInTheDocument();
  });

  it('仅有引用无输入也可发送（引用即内容）', () => {
    const sent: string[] = [];
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PromptComposer quotedContext="只有引用" onSend={(c) => sent.push(c)} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: /发送/ })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    expect(sent[0]).toContain('只有引用');
  });
});

describe('终端折条判别（批次 H.7）', () => {
  it('Bash/terminal 类判别为终端；普通工具不判别', async () => {
    const { isTerminalItem } = await import('../../src/client/components/workbench/ExecutionTraceCard');
    expect(isTerminalItem({ kind: 'tool_call', name: 'Bash', summary: 'Bash(npm test)', occurredAt: '', id: 'a', payload: {} } as never)).toBe(true);
    expect(isTerminalItem({ kind: 'tool_call', name: 'Read', summary: 'Read(a.md)', occurredAt: '', id: 'b', payload: {} } as never)).toBe(false);
    expect(isTerminalItem({ kind: 'thinking', summary: '想', occurredAt: '', id: 'c', payload: {} } as never)).toBe(false);
  });
});
