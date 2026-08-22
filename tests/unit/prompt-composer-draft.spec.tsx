/**
 * 批次 G.1：PromptComposer 草稿持久化。
 *
 * 覆盖：draftKey 读回/切换隔离/防抖落盘/发送清除/无 draftKey 纯内存（不落盘）。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptComposer } from '../../src/client/components/workbench/PromptComposer';

function renderComposer(props: { draftKey?: string; onSend?: (content: string) => void }): void {
  render(
    <PromptComposer
      draftKey={props.draftKey}
      onSend={props.onSend ?? (() => {})}
    />,
  );
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox');
}

describe('PromptComposer 草稿持久化（批次 G.1）', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(cleanup);

  it('draftKey 挂载时读回已存草稿', () => {
    localStorage.setItem('muster:composer-draft:v1:task:t1', '未发送的草稿');
    renderComposer({ draftKey: 'task:t1' });
    expect(textarea().value).toBe('未发送的草稿');
  });

  it('输入 300ms 防抖后落盘；清空即摘键', async () => {
    const user = userEvent.setup();
    renderComposer({ draftKey: 'task:t2' });
    await user.type(textarea(), '打了一段话');
    await waitFor(() => {
      expect(localStorage.getItem('muster:composer-draft:v1:task:t2')).toBe('打了一段话');
    }, { timeout: 2000 });
    await user.clear(textarea());
    await waitFor(() => {
      expect(localStorage.getItem('muster:composer-draft:v1:task:t2')).toBeNull();
    }, { timeout: 2000 });
  });

  it('切换 draftKey 换装对应草稿（同挂载点切任务）', async () => {
    const user = userEvent.setup();
    localStorage.setItem('muster:composer-draft:v1:task:b', '任务B的草稿');
    const { rerender } = render(<PromptComposer draftKey="task:a" onSend={() => {}} />);
    await user.type(textarea(), '任务A输入');
    rerender(<PromptComposer draftKey="task:b" onSend={() => {}} />);
    expect(textarea().value).toBe('任务B的草稿');
    // 切走前 A 的草稿已在防抖窗口内落盘
    await waitFor(() => {
      expect(localStorage.getItem('muster:composer-draft:v1:task:a')).toBe('任务A输入');
    }, { timeout: 2000 });
  });

  it('发送成功即清除草稿（不等防抖）', async () => {
    const user = userEvent.setup();
    renderComposer({ draftKey: 'task:t3' });
    await user.type(textarea(), '要发送的内容');
    await waitFor(() => {
      expect(localStorage.getItem('muster:composer-draft:v1:task:t3')).toBe('要发送的内容');
    }, { timeout: 2000 });
    await user.keyboard('{Enter}');
    expect(textarea().value).toBe('');
    expect(localStorage.getItem('muster:composer-draft:v1:task:t3')).toBeNull();
  });

  it('无 draftKey：纯内存，不读写 localStorage', async () => {
    const user = userEvent.setup();
    renderComposer({});
    await user.type(textarea(), '不留痕迹');
    expect(textarea().value).toBe('不留痕迹');
    await new Promise((r) => setTimeout(r, 450));
    expect(Object.keys(localStorage).filter((k) => k.startsWith('muster:composer-draft'))).toHaveLength(0);
  });
});
