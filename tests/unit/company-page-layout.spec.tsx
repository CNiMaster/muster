import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CompanyWorkNavigation } from '../../src/client/components/workbench/CompanyWorkNavigation';

describe('company page sections', () => {
  it('uses one calm vertical work list instead of nested horizontal tabs', async () => {
    const user = userEvent.setup();
    let selected = 'overview';
    const view = render(<CompanyWorkNavigation active="overview" projectCount={2} employeeCount={4} attentionCount={1} onChange={(value) => { selected = value; }} />);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /公司总览/ })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: /团队/ }));
    expect(selected).toBe('team');
    view.unmount();
  });

  it('E5：固定入口含「进化与报告」并可选中', async () => {
    const user = userEvent.setup();
    let selected = 'overview';
    const view = render(<CompanyWorkNavigation active="overview" projectCount={0} employeeCount={0} attentionCount={0} onChange={(value) => { selected = value; }} />);
    await user.click(screen.getByRole('button', { name: /进化与报告/ }));
    expect(selected).toBe('evolution');
    view.unmount();
  });
});
