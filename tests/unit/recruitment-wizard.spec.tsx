import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { RecruitmentWizard } from '../../src/client/components/agents/RecruitmentWizard';

function renderWizard(props: { onSubmit: ReturnType<typeof vi.fn> }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>
    <RecruitmentWizard
      profiles={[]}
      departments={[]}
      executors={[{ id: 'ep_1', name: 'Codex', manifestId: 'codex-cli', config: {}, connection: null }]}
      policies={[{ id: 'pp_1', name: '项目权限', approvalStrategy: 'ask-by-rule', scope: 'project', selectedDirectories: [] }]}
      onSubmit={props.onSubmit}
    />
  </QueryClientProvider>);
}

describe('recruitment wizard', () => {
  it('turns a role template into a reviewable bound employment draft', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWizard({ onSubmit });

    expect(screen.getByRole('button', { name: '从岗位模板招募' })).toBeVisible();
    await user.selectOptions(screen.getByLabelText('固定执行器'), 'ep_1');
    await user.selectOptions(screen.getByLabelText('权限范围'), 'pp_1');
    await user.click(screen.getByRole('button', { name: '预览任职' }));
    expect(screen.getByText('确认任职')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '确认招募' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'role-template',
      executorProfileId: 'ep_1',
      permissionPolicyId: 'pp_1',
    }));
  });
});
