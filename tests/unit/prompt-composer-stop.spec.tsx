/**
 * 批次 H8：PromptComposer 停止区三态（第五轮定稿：全局暂停主键 / ⌄全局急停 / 暂停中…禁用 / 发送）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptComposer } from '../../src/client/components/workbench/PromptComposer';

let stoppedAll: number;
let stoppedImmediate: number;

function renderComposer(props: Partial<Parameters<typeof PromptComposer>[0]> = {}): void {
  render(
    <PromptComposer
      isRunning
      onStop={() => { stoppedAll += 1; }}
      onStopImmediate={() => { stoppedImmediate += 1; }}
      runningCount={3}
      onSend={vi.fn()}
      {...props}
    />,
  );
}

describe('PromptComposer 停止区（批次 H8 第五轮定稿）', () => {
  beforeEach(() => {
    localStorage.clear();
    stoppedAll = 0;
    stoppedImmediate = 0;
  });
  afterEach(cleanup);

  it('空输入+运行中 → 主按钮=全局暂停，⌄菜单=立即停止本项目全部任务', () => {
    renderComposer();
    const btn = screen.getByRole('button', { name: '暂停本项目全部任务' });
    fireEvent.click(btn);
    expect(stoppedAll).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: '更多停止选项' }));
    const item = screen.getByText(/立即停止本项目全部任务/);
    expect(item.textContent).toContain('3 个执行中');
    fireEvent.click(item);
    expect(stoppedImmediate).toBe(1);
  });

  it('已请求暂停（等边界）→「暂停中…」禁用，连击无效', () => {
    renderComposer({ stopRequested: true });
    const btn = screen.getByRole('button', { name: /暂停中/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(stoppedAll).toBe(0);
    expect(screen.queryByRole('button', { name: '更多停止选项' })).not.toBeInTheDocument();
  });

  it('有输入 → 停止区让位，发送键可用（发送走排队/插话通道）', () => {
    renderComposer();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '追加要求' } });
    expect(screen.queryByRole('button', { name: '暂停本项目全部任务' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '更多停止选项' })).not.toBeInTheDocument();
    expect((screen.getByRole('button', { name: /发送/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('空闲（非运行）→ 无停止区，仅发送', () => {
    renderComposer({ isRunning: false });
    expect(screen.queryByRole('button', { name: '暂停本项目全部任务' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /暂停中/ })).not.toBeInTheDocument();
  });
});
