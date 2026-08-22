/**
 * 批次 I-a2：PanelPluginHost 宿主组件——零插件零渲染/互斥展开/markup 回传卡片/
 * 引用到对话事件/ready 驱高/超限截断/协议守卫丢弃。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelPluginHost, COMPOSER_QUOTE_EVENT, panelPluginEntryUrl } from '../../src/client/components/workbench/PanelPluginHost';
import type { PanelPluginDTO } from '../../src/client/hooks/queries';
import { PANEL_MARKUP_LIMIT, PANEL_HEIGHT_MAX } from '../../src/shared/panel-plugin-protocol';

afterEach(cleanup);

function makePanels(): PanelPluginDTO[] {
  return [
    { id: 'plg_deck', name: 'deck', title: '幻灯片', entry: 'panels/deck.html', height: 300, maturity: 'experimental' },
    { id: 'plg_board', name: 'board', title: '画板', entry: 'panels/board.html', height: 'auto', maturity: 'stable' },
  ];
}

/** 模拟已展开 iframe 的 contentWindow 往宿主发消息（宿主守卫只认 e.source===frames 之一）。 */
function postFromFrame(source: unknown, data: unknown): void {
  fireEvent(window, new MessageEvent('message', { data, source: source as Window }));
}

describe('PanelPluginHost（批次 I-a2）', () => {
  it('零插件 → 返回 null（组不渲染）', () => {
    const { container } = render(<PanelPluginHost projectId="pj_1" panels={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('折叠卡渲染标题；展开互斥；iframe sandbox=allow-scripts 且 src=entry 端点', () => {
    render(<PanelPluginHost projectId="pj_1" panels={makePanels()} />);
    expect(screen.getByText('幻灯片')).toBeTruthy();
    expect(screen.queryByTitle('面板插件 幻灯片')).toBeNull(); // 未展开无 iframe

    fireEvent.click(screen.getByText('幻灯片'));
    const frame1 = screen.getByTitle('面板插件 幻灯片') as HTMLIFrameElement;
    expect(frame1.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame1.getAttribute('src')).toBe(panelPluginEntryUrl('pj_1', 'plg_deck'));

    fireEvent.click(screen.getByText('画板'));
    expect(screen.queryByTitle('面板插件 幻灯片')).toBeNull(); // 互斥：上一个收起
    expect(screen.getByTitle('面板插件 画板')).toBeTruthy();
  });

  it('markup 回传 → 标记卡片（标题/标签/摘要）+「引用到对话」派发 CustomEvent', async () => {
    const heard: Array<{ text: string }> = [];
    const onQuote = (e: Event): void => { heard.push((e as CustomEvent<{ text: string }>).detail); };
    window.addEventListener(COMPOSER_QUOTE_EVENT, onQuote);
    render(<PanelPluginHost projectId="pj_1" panels={makePanels()} />);
    fireEvent.click(screen.getByText('幻灯片'));
    const frame = screen.getByTitle('面板插件 幻灯片') as HTMLIFrameElement;

    postFromFrame(frame.contentWindow, { v: 1, type: 'markup', payload: { page: 3, note: '重点' }, label: '第 3 页批注' });
    await waitFor(() => expect(screen.getByText(/第 3 页批注/)).toBeTruthy());
    expect(screen.getByText(/page/).textContent).toContain('重点');

    fireEvent.click(screen.getByRole('button', { name: '引用到对话' }));
    expect(heard.length).toBe(1);
    expect(heard[0]!.text).toContain('幻灯片·第 3 页批注');
    expect(heard[0]!.text).toContain('重点');
    window.removeEventListener(COMPOSER_QUOTE_EVENT, onQuote);
  });

  it('协议守卫：v!==1 或非白名单 type 的消息被丢弃', async () => {
    render(<PanelPluginHost projectId="pj_1" panels={makePanels()} />);
    fireEvent.click(screen.getByText('幻灯片'));
    const frame = screen.getByTitle('面板插件 幻灯片');
    postFromFrame(frame.contentWindow, { v: 2, type: 'markup', payload: 'x' });
    postFromFrame(frame.contentWindow, { v: 1, type: 'save-file', path: '/etc/x' });
    postFromFrame(window, { v: 1, type: 'markup', payload: '外部伪造' }); // source 不是自己的 iframe
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('button', { name: '引用到对话' })).toBeNull();
  });

  it('ready 高度驱动（夹紧上限）+ 超限 markup 截断提示', async () => {
    render(<PanelPluginHost projectId="pj_1" panels={makePanels()} />);
    fireEvent.click(screen.getByText('画板')); // height:'auto' → 默认 320 起步
    const frame = screen.getByTitle('面板插件 画板') as HTMLIFrameElement;
    expect(parseInt(frame.style.height, 10)).toBe(320);

    postFromFrame(frame.contentWindow, { v: 1, type: 'ready', height: 99999 });
    await waitFor(() => {
      const f = screen.getByTitle('面板插件 画板') as HTMLIFrameElement;
      expect(parseInt(f.style.height, 10)).toBe(PANEL_HEIGHT_MAX);
    });

    const toastSpy = vi.spyOn(await import('../../src/client/components/Button'), 'toast');
    postFromFrame(frame.contentWindow, { v: 1, type: 'markup', payload: 'x'.repeat(PANEL_MARKUP_LIMIT + 50) });
    await waitFor(() => expect(screen.getByText(/已截断/)).toBeTruthy());
    expect(toastSpy).toHaveBeenCalled();
    toastSpy.mockRestore();
  });
});
