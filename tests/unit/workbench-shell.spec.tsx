import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { WorkbenchShell } from '../../src/client/components/workbench/WorkbenchShell';

describe('calm workbench shell', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
    localStorage.clear();
    localStorage.setItem('muster:workbench-guide:v1', 'done');
  });
  afterEach(cleanup);

  it('independently hides panes and persists the choice', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><WorkbenchShell scopeKey="project:1" breadcrumb="工作台 / 项目" navigationLabel="项目工作列表" inspectorLabel="项目现场" navigation={<p>任务列表</p>} inspector={<p>当前现场</p>}><p>当前工作</p></WorkbenchShell></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: '收起工作列表' }));
    expect(screen.queryByText('任务列表')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('muster:workbench:project:1') ?? '{}').leftOpen).toBe(false);
    await user.click(screen.getByRole('button', { name: '收起现场信息' }));
    expect(screen.queryByText('当前现场')).not.toBeInTheDocument();
  });

  it('opens the single global command menu from the toolbar', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><WorkbenchShell scopeKey="company:1" breadcrumb="工作台" navigationLabel="工作台工作列表" inspectorLabel="工作台现场" navigation={<p>导航</p>} inspector={<p>现场</p>}><p>内容</p></WorkbenchShell></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: '搜索或跳转' }));
    expect(screen.getByRole('dialog', { name: '搜索或跳转' })).toBeVisible();
    expect(within(screen.getByRole('dialog', { name: '搜索或跳转' })).getByRole('link', { name: '执行器' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '搜索或跳转' })).not.toBeInTheDocument();
  });

  it('keeps the saved desktop pane choice when a narrow viewport temporarily hides it', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MemoryRouter><WorkbenchShell scopeKey="project:responsive" breadcrumb="工作台 / 项目" navigationLabel="项目工作列表" inspectorLabel="项目现场" navigation={<p>任务列表</p>} inspector={<p>当前现场</p>}><p>当前工作</p></WorkbenchShell></MemoryRouter>);
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
    rerender(<MemoryRouter><WorkbenchShell scopeKey="project:responsive" breadcrumb="工作台 / 项目" navigationLabel="项目工作列表" inspectorLabel="项目现场" navigation={<p>任务列表</p>} inspector={<p>当前现场</p>}><p>当前工作</p></WorkbenchShell></MemoryRouter>);
    expect(screen.queryByText('任务列表')).not.toBeInTheDocument();
  });
});
