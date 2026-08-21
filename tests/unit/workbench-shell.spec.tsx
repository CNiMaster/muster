import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchShell } from '../../src/client/components/workbench/WorkbenchShell';

/** 治理批次5：Shell 内 useUiMode 需要 QueryClient；命令面板断言专业项时预置 pro。 */
function qcShell(uiMode: 'simple' | 'pro' = 'pro'): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['systemSettings'], { uiMode });
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
    localStorage.setItem('muster:workbench-guide:v1', 'done');
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
    // 右栏默认 304：向左拖 40px 变宽到 344
    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 1000 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 960 });
    // 拖拽中仍是旧值（304），实时宽度只在内存里
    expect(JSON.parse(localStorage.getItem('muster:workbench:project:resize') ?? '{}').rightWidth).toBe(304);
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 960 });
    expect(JSON.parse(localStorage.getItem('muster:workbench:project:resize') ?? '{}').rightWidth).toBe(344);
  });

  it('批次F.2：拖拽越界钳制在合法范围（右栏 ≤420）', () => {
    renderShell('project:clamp');
    const handle = screen.getByRole('separator', { name: '调整右侧信息栏宽度' });
    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 1000 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 400 });
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 400 });
    expect(JSON.parse(localStorage.getItem('muster:workbench:project:clamp') ?? '{}').rightWidth).toBe(420);
  });

  it('批次F.2：双击手柄重置默认宽度', () => {
    localStorage.setItem('muster:workbench:project:reset', JSON.stringify({ leftOpen: true, rightOpen: true, leftWidth: 300, rightWidth: 400 }));
    renderShell('project:reset');
    fireEvent.dblClick(screen.getByRole('separator', { name: '调整右侧信息栏宽度' }));
    expect(JSON.parse(localStorage.getItem('muster:workbench:project:reset') ?? '{}').rightWidth).toBe(304);
  });

  it('批次F.2：窄视口（抽屉态）不渲染拖拽手柄', async () => {
    renderShell('project:narrow');
    expect(screen.getByRole('separator', { name: '调整右侧信息栏宽度' })).toBeInTheDocument();
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1000 });
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => {
      expect(screen.queryByRole('separator', { name: '调整右侧信息栏宽度' })).not.toBeInTheDocument();
    });
  });
});
