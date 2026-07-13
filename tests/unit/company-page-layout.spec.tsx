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
    expect(screen.getByRole('button', { name: /公司概览/ })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: /员工看板/ }));
    expect(selected).toBe('team');
    view.unmount();
  });
});
