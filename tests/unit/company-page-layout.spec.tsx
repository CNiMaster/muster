import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CompanyWorkNavigation } from '../../src/client/components/workbench/CompanyWorkNavigation';

// 蓝图组织批次2：导航新增归档入口（Link + useParams），组件需在带 :companyId 路由参数的 Router 上下文内渲染。
function renderNav(props: Parameters<typeof CompanyWorkNavigation>[0]) {
  return render(
    <MemoryRouter initialEntries={['/companies/c_1']}>
      <Routes>
        <Route path="/companies/:companyId" element={<CompanyWorkNavigation {...props} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('company page sections', () => {
  it('uses one calm vertical work list instead of nested horizontal tabs', async () => {
    const user = userEvent.setup();
    let selected = 'overview';
    const view = renderNav({ active: 'overview', projectCount: 2, employeeCount: 4, attentionCount: 1, evolutionCount: 0, onChange: (value) => { selected = value; } });
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /工作台总览/ })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: /团队/ }));
    expect(selected).toBe('team');
    view.unmount();
  });

  it('E5：固定入口含「进化与报告」并可选中', async () => {
    const user = userEvent.setup();
    let selected = 'overview';
    const view = renderNav({ active: 'overview', projectCount: 0, employeeCount: 0, attentionCount: 0, evolutionCount: 0, onChange: (value) => { selected = value; } });
    await user.click(screen.getByRole('button', { name: /进化与报告/ }));
    expect(selected).toBe('evolution');
    view.unmount();
  });

  it('E5 补齐：进化入口显示待审批计数红点（有数显示、零不显示）', () => {
    const withCount = renderNav({ active: 'overview', projectCount: 0, employeeCount: 0, attentionCount: 0, evolutionCount: 3, onChange: () => {} });
    expect(withCount.getByRole('button', { name: /进化与报告/ }).textContent).toContain('3');
    withCount.unmount();

    const withoutCount = renderNav({ active: 'overview', projectCount: 0, employeeCount: 0, attentionCount: 0, evolutionCount: 0, onChange: () => {} });
    expect(withoutCount.getByRole('button', { name: /进化与报告/ }).textContent).not.toContain('0');
    withoutCount.unmount();
  });

  it('蓝图组织批次2：固定入口含「归档」链接（跨项目知识库）', () => {
    const view = renderNav({ active: 'overview', projectCount: 0, employeeCount: 0, attentionCount: 0, evolutionCount: 0, onChange: () => {} });
    expect(screen.getByRole('link', { name: /归档/ })).toHaveAttribute('href', '/companies/c_1/archive');
    view.unmount();
  });
});
