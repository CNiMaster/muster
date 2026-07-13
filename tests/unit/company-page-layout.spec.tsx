import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CompanySections, type CompanySectionKey } from '../../src/client/components/company/CompanySections';

describe('company page sections', () => {
  it('renders overview only until another tab is selected', async () => {
    const user = userEvent.setup();
    let active: CompanySectionKey = 'overview';
    const view = render(<CompanySections
      active={active}
      onChange={(next) => {
        active = next;
        view.rerender(<CompanySections
          active={active}
          onChange={() => undefined}
          overview={<p>推荐下一步</p>}
          team={<p>新部门名称</p>}
          projects={<p>项目列表</p>}
          activity={<p>公司对话</p>}
          settings={<p>公司章程</p>}
        />);
      }}
      overview={<p>推荐下一步</p>}
      team={<p>新部门名称</p>}
      projects={<p>项目列表</p>}
      activity={<p>公司对话</p>}
      settings={<p>公司章程</p>}
    />);

    expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('推荐下一步')).toBeVisible();
    expect(screen.queryByText('新部门名称')).not.toBeInTheDocument();
    expect(screen.queryByText('公司对话')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '团队' }));
    expect(screen.getByText('新部门名称')).toBeVisible();
    expect(screen.queryByText('推荐下一步')).not.toBeInTheDocument();
  });
});
