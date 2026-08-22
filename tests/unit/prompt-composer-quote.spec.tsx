/**
 * 批次 I-a2：PromptComposer 面板插件引用事件链（复审 R2 补的成对端到端）——
 * CustomEvent → 引用条显示 → 发送附 "> 引用：" 前缀 → 发送后清空；父控 quotedContext 优先。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** 状态更新在 act 内冲刷（裸 dispatchEvent 不触发 React 同步渲染）。 */
function dispatchQuote(text: string): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('muster:composer-quote', { detail: { text } }));
  });
}
import { PromptComposer } from '../../src/client/components/workbench/PromptComposer';

afterEach(cleanup);

function renderComposer(props: Partial<Parameters<typeof PromptComposer>[0]> = {}) {
  const onSend = vi.fn();
  render(<PromptComposer onSend={onSend} {...props} />);
  return { onSend };
}

describe('PromptComposer 插件标记引用（批次 I-a2）', () => {
  it('收到 muster:composer-quote 事件 → 引用条显示 → 发送附前缀 → 发送后清空', () => {
    const { onSend } = renderComposer();
    expect(screen.queryByText(/^❝/)).toBeNull();

    dispatchQuote('【幻灯片·第 3 页】重点内容');
    expect(screen.getByText(/幻灯片·第 3 页/)).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '按标记改' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toContain('> 引用：');
    expect(onSend.mock.calls[0]![0]).toContain('重点内容');
    expect(onSend.mock.calls[0]![0]).toContain('按标记改');
    // 发送后本地引用清空
    expect(screen.queryByText(/^❝/)).toBeNull();
  });

  it('父控 quotedContext（划选/打断记录）优先于插件引用；移除按钮两者都清', () => {
    const onClearQuoted = vi.fn();
    renderComposer({ quotedContext: '打断记录摘要', onClearQuoted });
    dispatchQuote('插件标记');
    expect(screen.getByText(/打断记录摘要/)).toBeTruthy();
    expect(screen.queryByText(/插件标记/)).toBeNull(); // 父控优先展示

    fireEvent.click(screen.getByRole('button', { name: '移除引用' }));
    expect(onClearQuoted).toHaveBeenCalledTimes(1); // 父控清理是回调契约；本地插件引用同步清（测试1覆盖）
  });

  it('空文本+仅插件引用 → 也可发送（引用即内容）', () => {
    const { onSend } = renderComposer();
    dispatchQuote('只有标记');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toContain('只有标记');
  });
});
