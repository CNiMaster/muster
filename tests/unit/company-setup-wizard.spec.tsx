import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CompanySetupWizard } from '../../src/client/components/company/CompanySetupWizard';
import type { CompanySetupDraft } from '../../src/client/domain/company-templates';

const draft: CompanySetupDraft = {
  templateId: 'software',
  name: 'Acme',
  goal: '发布产品',
  departments: [{ key: 'engineering', name: '工程部' }],
  employees: [{ key: 'engineer', name: '软件工程师', role: 'engineer', responsibilities: '实现产品', departmentKey: 'engineering', isLead: true }],
  project: { name: '首个软件项目', description: '发布产品' },
  firstProjectTask: { title: '梳理需求', brief: '定义范围' },
};

describe('company setup wizard', () => {
  it('requires every employee to have an executor and permission policy', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><CompanySetupWizard
      profiles={[{ id: 'ep_codex', name: 'Codex', manifestId: 'codex-cli', config: {}, connection: { status: 'connected', classification: null, version: '1.0', completedAt: '2026-07-13T00:00:00Z' } }]}
      policies={[{ id: 'pp_project', name: '项目权限', approvalStrategy: 'ask-by-rule', scope: 'project', selectedDirectories: [] }]}
      onPreview={vi.fn(async () => draft)}
      onCommit={vi.fn(async () => undefined)}
    /></MemoryRouter>);

    await user.selectOptions(screen.getByLabelText('公司模板'), 'software');
    await user.type(screen.getByLabelText(/公司名称/), 'Acme');
    await user.type(screen.getByLabelText(/公司目标/), '发布产品');
    await user.click(screen.getByRole('button', { name: '生成团队预览' }));
    expect(await screen.findByText('第二步：确认团队')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '下一步' }));

    const next = screen.getByRole('button', { name: '下一步' });
    expect(next).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('软件工程师固定执行器'), 'ep_codex');
    await user.selectOptions(screen.getByLabelText('软件工程师权限范围'), 'pp_project');
    expect(next).toBeEnabled();
  });
});
