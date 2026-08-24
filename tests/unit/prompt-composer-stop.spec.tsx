/**
 * 发送区 ⌄ 菜单（2026-08-24 定案）：发送主键常驻；⌄ 菜单=全局暂停/全局停止两项——
 * 只针对当前任务，在跑才可选，没跑置灰；等边界期间（stopRequested）显示「暂停中…」提示条且两项禁用。
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
      onSend={vi.fn()}
      {...props}
    />,
  );
}

function openSendMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: '当前任务暂停或停止' }));
}

function menuItem(label: string): HTMLButtonElement {
  return screen.getByText(label).closest('button') as HTMLButtonElement;
}

describe('发送区 ⌄ 菜单（2026-08-24 定案：全局暂停/全局停止，只管当前任务）', () => {
  beforeEach(() => {
    localStorage.clear();
    stoppedAll = 0;
    stoppedImmediate = 0;
  });
  afterEach(cleanup);

  it('在跑 → 两项可选：全局暂停/全局停止分别触发当前任务的暂停与停止', () => {
    renderComposer();
    openSendMenu();
    const pauseBtn = menuItem('全局暂停');
    expect(pauseBtn.disabled).toBe(false);
    fireEvent.click(pauseBtn);
    expect(stoppedAll).toBe(1);

    openSendMenu();
    const stopBtn = menuItem('全局停止');
    expect(stopBtn.disabled).toBe(false);
    fireEvent.click(stopBtn);
    expect(stoppedImmediate).toBe(1);
  });

  it('已请求暂停（等边界）→「暂停中…」提示条（非按钮），两项禁用连击无效', () => {
    renderComposer({ stopRequested: true });
    expect(screen.getByText(/暂停中/).tagName).toBe('SPAN');
    openSendMenu();
    const pauseBtn = menuItem('全局暂停');
    expect(pauseBtn.disabled).toBe(true);
    fireEvent.click(pauseBtn);
    expect(stoppedAll).toBe(0);
    expect(menuItem('全局停止').disabled).toBe(true);
  });

  it('有输入 → 发送键可用（发送走排队/插话通道），⌄ 菜单常驻不因输入消失', () => {
    renderComposer();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '追加要求' } });
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: '当前任务暂停或停止' })).toBeInTheDocument();
  });

  it('空闲（非运行）→ 两项置灰不可点，无「暂停中…」提示', () => {
    renderComposer({ isRunning: false });
    expect(screen.queryByText(/暂停中/)).not.toBeInTheDocument();
    openSendMenu();
    expect(menuItem('全局暂停').disabled).toBe(true);
    expect(menuItem('全局停止').disabled).toBe(true);
  });
});
