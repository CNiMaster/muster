import type React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchShell } from '../../src/client/components/workbench/WorkbenchShell';
import { useToasts } from '../../src/client/components/Button';

/** toast 是发布订阅制，测试里挂一个宿主承接提示文本。 */
function ToastHost(): React.ReactElement {
  const { toasts } = useToasts();
  return <div>{toasts.map((t) => <span key={t.id}>{t.message}</span>)}</div>;
}

/** 治理批次5：Shell 内 useUiMode 需要 QueryClient；命令面板断言专业项时预置 pro。 */
function qcShell(uiMode: 'simple' | 'pro' = 'pro'): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['systemSettings'], { uiMode, workbenchGuideDone: true });
  return qc;
}

function renderShell(scopeKey: string): void {
  render(
    <QueryClientProvider client={qcShell()}>
      <MemoryRouter>
        <WorkbenchShell scopeKey={scopeKey} breadcrumb="工作台 / 项目" navigationLabel="项目工作列表" inspectorLabel="项目现场" navigation={<p>任务列表</p>} inspector={<p>当前现场</p>}>
          <p>当前工作</p>
        </WorkbenchShell>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('calm workbench shell', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
    localStorage.clear();
  });
  afterEach(cleanup);

  it('independently hides panes and persists the choice', async () => {
    const user = userEvent.setup();
    render(<QueryClientProvider client={qcShell()}><MemoryRouter><WorkbenchShell scopeKey="project:1" breadcrumb="工作台 / 项目" navigationLabel="项目工作列表" inspectorLabel="项目现场" navigation={<p>任务列表</p>} inspector={<p>当前现场</p>}><p>当前工作</p></WorkbenchShell></MemoryRouter></QueryClientProvider>);
    await user.click(screen.getByRole('button', { name: '收起工作列表' }));
    expect(screen.queryByText('任务列表')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('muster:workbench:project:1') ?? '{}').leftOpen).toBe(false);
    await user.click(screen.getByRole('button', { name: '收起现场信息' }));
    expect(screen.queryByText('当前现场')).not.toBeInTheDocument();
  });

  it('opens the single global command menu from the toolbar', async () => {
    const user = userEvent.setup();
    render(<QueryClientProvider client={qcShell()}><MemoryRouter><WorkbenchShell scopeKey="company:1" breadcrumb="工作台" navigationLabel="工作台工作列表" inspectorLabel="工作台现场" navigation={<p>导航</p>} inspector={<p>现场</p>}><p>内容</p></WorkbenchShell></MemoryRouter></QueryClientProvider>);
    await user.click(screen.getByRole('button', { name: '搜索或跳转' }));
    expect(screen.getByRole('dialog', { name: '搜索或跳转' })).toBeVisible();
    expect(within(screen.getByRole('dialog', { name: '搜索或跳转' })).getByRole('link', { name: '执行器' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '搜索或跳转' })).not.toBeInTheDocument();
  });

  it('keeps the saved desktop pane choice when a narrow viewport temporarily hides it', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<QueryClientProvider client={qcShell()}><MemoryRouter><WorkbenchShell scopeKey="project:responsive" breadcrumb="工作台 / 项目" navigationLabel="项目工作列表" inspectorLabel="项目现场" navigation={<p>任务列表</p>} inspector={<p>当前现场</p>}><p>当前工作</p></WorkbenchShell></MemoryRouter></QueryClientProvider>);
    expect(screen.getByText('任务列表')).toBeVisible();
    expect(screen.getByText('当前现场')).toBeVisible();

    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => {
      expect(screen.queryByText('任务列表')).not.toBeInTheDocument();
      expect(screen.queryByText('当前现场')).not.toBeInTheDocument();
    });
    expect(JSON.parse(localStorage.getItem('muster:workbench:project:responsive') ?? '{}')).toMatchObject({ leftOpen: true, rightOpen: true });

    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => {
      expect(screen.getByText('任务列表')).toBeVisible();
      expect(screen.getByText('当前现场')).toBeVisible();
    });

    await user.click(screen.getByRole('button', { name: '收起工作列表' }));
    rerender(<QueryClientProvider client={qcShell()}><MemoryRouter><WorkbenchShell scopeKey="project:responsive" breadcrumb="工作台 / 项目" navigationLabel="项目工作列表" inspectorLabel="项目现场" navigation={<p>任务列表</p>} inspector={<p>当前现场</p>}><p>当前工作</p></WorkbenchShell></MemoryRouter></QueryClientProvider>);
    expect(screen.queryByText('任务列表')).not.toBeInTheDocument();
  });

  it('批次F.2：拖拽右栏实时变宽、拖拽中不落盘、松手才持久化', () => {
    renderShell('project:resize');
    const handle = screen.getByRole('separator', { name: '调整右侧信息栏宽度' });
    // 右栏默认 360（2026-08-24 起右栏承载工具页加宽默认）：向左拖 40px 变宽到 400
    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 1000 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 960 });
    // 拖拽中仍是旧值（360），实时宽度只在内存里
    expect(JSON.parse(localStorage.getItem('muster:workbench:project:resize') ?? '{}').rightWidth).toBe(360);
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 960 });
    expect(JSON.parse(localStorage.getItem('muster:workbench:project:resize') ?? '{}').rightWidth).toBe(400);
  });

  it('批次F.2：拖拽越界钳制在合法范围（右栏 ≤960）', () => {
    renderShell('project:clamp');
    const handle = screen.getByRole('separator', { name: '调整右侧信息栏宽度' });
    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 1000 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 400 });
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 400 });
    expect(JSON.parse(localStorage.getItem('muster:workbench:project:clamp') ?? '{}').rightWidth).toBe(960);
  });

  it('批次F.2：双击手柄重置默认宽度', () => {
    localStorage.setItem('muster:workbench:project:reset', JSON.stringify({ leftOpen: true, rightOpen: true, leftWidth: 300, rightWidth: 400 }));
    renderShell('project:reset');
    fireEvent.dblClick(screen.getByRole('separator', { name: '调整右侧信息栏宽度' }));
    expect(JSON.parse(localStorage.getItem('muster:workbench:project:reset') ?? '{}').rightWidth).toBe(360);
  });

  it('批次F.2：抽屉态（<740）不渲染拖拽手柄；1000px 窄桌面仍三栏可拖', async () => {
    renderShell('project:narrow');
    expect(screen.getByRole('separator', { name: '调整右侧信息栏宽度' })).toBeInTheDocument();
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 700 });
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => {
      expect(screen.queryByRole('separator', { name: '调整右侧信息栏宽度' })).not.toBeInTheDocument();
    });
    // 回到 1000px 窄桌面：三栏共存，手柄重新可用（新断点 740 的核心语义）
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1000 });
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => {
      expect(screen.getByRole('separator', { name: '调整右侧信息栏宽度' })).toBeInTheDocument();
    });
  });
});

describe('⌘K 面板升级（批次 G.7）', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
    localStorage.clear();
  });
  afterEach(cleanup);

  it('简单模式：专业项可见但灰态锁定 +「专业」小标，点击提示而非跳转', async () => {
    const user = userEvent.setup();
    render(<QueryClientProvider client={qcShell('simple')}><MemoryRouter><WorkbenchShell scopeKey="g7:simple" breadcrumb="工作台" navigationLabel="工作列表" inspectorLabel="现场" navigation={<p>导航</p>} inspector={<p>现场</p>}><p>内容</p></WorkbenchShell><ToastHost /></MemoryRouter></QueryClientProvider>);
    await user.click(screen.getByRole('button', { name: '搜索或跳转' }));
    const dialog = screen.getByRole('dialog', { name: '搜索或跳转' });
    // 专业项渲染为锁定 button（非 link），带「专业」小标
    const locked = within(dialog).getByRole('button', { name: /蓝图库/ });
    expect(locked).toBeVisible();
    expect(within(locked).getByText('专业')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: '蓝图库' })).not.toBeInTheDocument();
    // 点击出提示不导航
    await user.click(locked);
    expect(await screen.findByText(/专业模式功能/)).toBeInTheDocument();
  });

  it('commandOptions 注入任务/文件组：文件条目带 ?preview= 直开右栏预览', async () => {
    const user = userEvent.setup();
    render(<QueryClientProvider client={qcShell('pro')}><MemoryRouter><WorkbenchShell
      scopeKey="g7:inject"
      breadcrumb="工作台" navigationLabel="工作列表" inspectorLabel="现场"
      navigation={<p>导航</p>} inspector={<p>现场</p>}
      commandOptions={[
        { label: '#3 修复登录', href: '/projects/p1?view=task&projectTask=pt_3', group: '项目任务' },
        { label: '文件：docs/报告.md', href: '/projects/p1?preview=docs%2F%E6%8A%A5%E5%91%8A.md', group: '项目文件' },
      ]}
    ><p>内容</p></WorkbenchShell></MemoryRouter></QueryClientProvider>);
    await user.click(screen.getByRole('button', { name: '搜索或跳转' }));
    const dialog = screen.getByRole('dialog', { name: '搜索或跳转' });
    expect(within(dialog).getByRole('link', { name: '#3 修复登录' })).toHaveAttribute('href', '/projects/p1?view=task&projectTask=pt_3');
    expect(within(dialog).getByRole('link', { name: '文件：docs/报告.md' })).toHaveAttribute('href', '/projects/p1?preview=docs%2F%E6%8A%A5%E5%91%8A.md');
  });
});
