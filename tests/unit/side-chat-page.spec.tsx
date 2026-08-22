/**
 * 批次 I-b 组件：SideChatPage——渲染/发送回调（Enter+按钮）/清空确认弹窗/思考中态。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SideChatPage } from '../../src/client/pages/SideChatPage';
import * as queries from '../../src/client/hooks/queries';
import type { SideChatMessageDTO } from '../../src/client/hooks/queries';
import type React from 'react';

afterEach(cleanup);

function mockHooks(opts: { messages?: SideChatMessageDTO[]; pending?: boolean } = {}): { sendFn: ReturnType<typeof vi.fn> } {
  const sendFn = vi.fn().mockResolvedValue({ user: { role: 'user' }, assistant: { role: 'assistant', content: 'ok' } });
  vi.spyOn(queries, 'useSideMessages').mockReturnValue({
    data: opts.messages ?? [], isLoading: false, isPending: false, isFetching: false,
  } as unknown as ReturnType<typeof queries.useSideMessages>);
  vi.spyOn(queries, 'useSendSideMessage').mockReturnValue({
    mutate: sendFn, isPending: opts.pending ?? false,
  } as unknown as ReturnType<typeof queries.useSendSideMessage>);
  vi.spyOn(queries, 'useClearSideChat').mockReturnValue({
    mutate: vi.fn(), isPending: false,
  } as unknown as ReturnType<typeof queries.useClearSideChat>);
  return { sendFn };
}

describe('SideChatPage（批次 I-b）', () => {
  it('空会话：引导文案 + 输入框 + 清空入口', () => {
    mockHooks();
    render(<SideChatPage />);
    expect(screen.getByText(/随手问一句/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '清空会话' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
  });

  it('Enter 发送（Shift+Enter 换行不发送；pending 态拦重复发送）', () => {
    const { sendFn } = mockHooks({ pending: false });
    render(<SideChatPage />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '问个问题' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true }); // 换行不发送
    expect(sendFn).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('问个问题', expect.anything());
  });

  it('发送中显示思考中（pending 态）', () => {
    mockHooks({ pending: true });
    render(<SideChatPage />);
    expect(screen.getByText(/思考中/)).toBeTruthy();
  });

  it('消息气泡渲染（user/assistant）+ 清空确认弹窗两段式', () => {
    mockHooks({ messages: [
      { id: 'm1', role: 'user', author: 'user', content: '你好', createdAt: new Date().toISOString() },
      { id: 'm2', role: 'assistant', author: 'ag_lead', content: '在的', createdAt: new Date().toISOString() },
    ] });
    render(<SideChatPage />);
    expect(screen.getByText('你好')).toBeTruthy();
    expect(screen.getByText('在的')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '清空会话' }));
    expect(screen.getByText(/确定清空全部侧边对话记录/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '清空' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  });
});
