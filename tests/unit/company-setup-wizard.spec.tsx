import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => sessionStorage.clear());
  afterEach(() => cleanup());

  it('automatically applies the default executor and permission policy', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><CompanySetupWizard
      profiles={[{ id: 'ep_codex', name: 'Codex', manifestId: 'codex-cli', config: {}, connection: { status: 'connected', classification: null, version: '1.0', completedAt: '2026-07-13T00:00:00Z' } }]}
      policies={[{ id: 'pp_project', name: '项目权限', approvalStrategy: 'ask-by-rule', scope: 'project', selectedDirectories: [] }]}
      onPreview={vi.fn(async () => draft)}
      onCommit={vi.fn(async () => undefined)}
    /></MemoryRouter>);

    await user.click(screen.getByRole('button',{name:'选择软件研发公司'}));
    await user.type(screen.getByLabelText(/公司名称/), 'Acme');
    await user.type(screen.getByLabelText(/一句话目标/), '发布产品');
    await user.click(screen.getByRole('button', { name: '先看看团队' }));
    expect(await screen.findByText('团队已经排好')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '继续 →' }));

    expect(await screen.findByText('默认配置已自动应用')).toBeVisible();
    expect(screen.getByRole('button', { name: '继续 →' })).toBeEnabled();
  });

  it('can preview and commit the default company in one click', async()=>{
    const user=userEvent.setup();const commit=vi.fn(async()=>undefined);
    render(<MemoryRouter><CompanySetupWizard profiles={[{id:'ep',name:'Codex',manifestId:'codex-cli',config:{},connection:null}]} policies={[{id:'pp',name:'项目安全',approvalStrategy:'ask-by-rule',scope:'project',selectedDirectories:[]}]} onPreview={vi.fn(async()=>draft)} onCommit={commit}/></MemoryRouter>);
    await user.type(screen.getByLabelText(/公司名称/),'Acme');await user.type(screen.getByLabelText(/一句话目标/),'发布产品');
    await user.click(screen.getByRole('button',{name:'一键创建并进入项目 →'}));
    expect(commit).toHaveBeenCalledWith(draft,{engineer:{executorProfileId:'ep',permissionPolicyId:'pp'}});
  });
});
