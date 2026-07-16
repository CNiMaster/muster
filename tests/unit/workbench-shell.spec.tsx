import { cleanup, render, screen } from '@testing-library/react';
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
    render(<MemoryRouter><WorkbenchShell scopeKey="project:1" breadcrumb="公司 / 项目" navigationLabel="项目工作列表" inspectorLabel="项目现场" navigation={<p>任务列表</p>} inspector={<p>当前现场</p>}><p>当前工作</p></WorkbenchShell></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: '收起工作列表' }));
    expect(screen.queryByText('任务列表')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('muster:workbench:project:1') ?? '{}').leftOpen).toBe(false);
    await user.click(screen.getByRole('button', { name: '收起现场信息' }));
    expect(screen.queryByText('当前现场')).not.toBeInTheDocument();
  });

  it('opens the single global command menu from the toolbar', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><WorkbenchShell scopeKey="company:1" breadcrumb="公司" navigationLabel="公司工作列表" inspectorLabel="公司现场" navigation={<p>导航</p>} inspector={<p>现场</p>}><p>内容</p></WorkbenchShell></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: '搜索或跳转' }));
    expect(screen.getByRole('dialog', { name: '搜索或跳转' })).toBeVisible();
    expect(screen.getByRole('link', { name: '执行器' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '搜索或跳转' })).not.toBeInTheDocument();
  });
});
