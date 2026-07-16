import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanySetupWizard } from '../../src/client/components/company/CompanySetupWizard';
import type { CompanySetupDraft } from '../../src/client/domain/company-templates';
import { createBuiltinCompanyTemplateDraft } from '../../src/server/domain/template-registry';

const draft: CompanySetupDraft = createBuiltinCompanyTemplateDraft({ templateId: 'software', name: 'Acme', goal: '发布产品' });

describe('company setup wizard', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => cleanup());

  it('automatically applies the default executor and permission policy', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><CompanySetupWizard
      profiles={[{ id: 'ep_codex', name: 'Codex', manifestId: 'codex-cli', config: {}, connection: { status: 'connected', classification: null, version: '1.0', completedAt: '2026-07-13T00:00:00Z' } }]}
      policies={[{ id: 'pp_project', name: '项目权限', approvalStrategy: 'ask-by-rule', scope: 'project', selectedDirectories: [] }]}
      onPreview={vi.fn(async () => draft)}
      onCommit={vi.fn(async () => true)}
    /></MemoryRouter>);

    await user.click(screen.getByRole('button',{name:'选择软件研发公司'}));
    await user.type(screen.getByLabelText(/公司名称/), 'Acme');
    await user.type(screen.getByLabelText(/一句话目标/), '发布产品');
    await user.click(screen.getByRole('button', { name: '生成公司蓝图 →' }));
    expect(await screen.findByText('公司蓝图已生成，请确认')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '继续到运行' }));

    expect(await screen.findByText('默认配置已自动应用')).toBeVisible();
    expect(screen.getByRole('button', { name: '继续到项目' })).toBeEnabled();
  });

  it('shows the same connected executor that automatic binding will use', () => {
    render(<MemoryRouter><CompanySetupWizard
      profiles={[
        { id: 'ep_codex', name: 'Codex', manifestId: 'codex-cli', config: {}, connection: { status: 'failed', classification: null, version: null, completedAt: '2026-07-13T00:00:00Z' } },
        { id: 'ep_antigravity', name: 'Antigravity', manifestId: 'antigravity', config: {}, connection: { status: 'connected', classification: null, version: '2.0', completedAt: '2026-07-13T00:00:00Z' } },
      ]}
      policies={[{ id: 'pp_project', name: '项目权限', approvalStrategy: 'ask-by-rule', scope: 'project', selectedDirectories: [] }]}
      onPreview={vi.fn(async () => draft)}
      onCommit={vi.fn(async () => true)}
    /></MemoryRouter>);

    expect(screen.getByText('将自动使用 Antigravity · 项目权限')).toBeVisible();
  });

  it('renders a server-provided template without a client enum or dedicated mark mapping', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><CompanySetupWizard
      templates={[
        { id: 'general', name: '通用项目公司', description: '通用交付', roles: ['lead'], mark: '通', colorToken: 'blue', maturity: 'ready', recommendedUse: '通用项目', version: 1 },
        { id: 'research-lab', name: '研究公司', description: '证据驱动研究', roles: ['lead', 'researcher'], mark: '研', colorToken: 'purple', maturity: 'experimental', recommendedUse: '研究与报告', version: 1 },
      ]}
      profiles={[]}
      policies={[]}
      onPreview={vi.fn(async () => draft)}
      onCommit={vi.fn(async () => true)}
    /></MemoryRouter>);

    const research = screen.getByRole('button', { name: '选择研究公司' });
    expect(research).toBeVisible();
    expect(screen.getByText('研')).toBeVisible();
    await user.click(research);
    expect(research).toHaveAttribute('aria-pressed', 'true');
  });

  it('requires blueprint review before committing the company', async()=>{
    const user=userEvent.setup();const commit=vi.fn(async()=>true);
    render(<MemoryRouter><CompanySetupWizard profiles={[{id:'ep',name:'Codex',manifestId:'codex-cli',config:{},connection:null}]} policies={[{id:'pp',name:'项目安全',approvalStrategy:'ask-by-rule',scope:'project',selectedDirectories:[]}]} onPreview={vi.fn(async()=>draft)} onCommit={commit}/></MemoryRouter>);
    await user.type(screen.getByLabelText(/公司名称/),'Acme');await user.type(screen.getByLabelText(/一句话目标/),'发布产品');
    await user.click(screen.getByRole('button',{name:'生成公司蓝图 →'}));
    expect(await screen.findByText('公司蓝图已生成，请确认')).toBeVisible();
    expect(commit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:'继续到运行'}));
    await user.click(screen.getByRole('button',{name:'继续到项目'}));
    await user.click(screen.getByRole('button',{name:'继续到完成'}));
    await user.click(screen.getByRole('button',{name:'按推荐方案创建并进入项目 →'}));
    expect(commit).toHaveBeenCalledWith(draft,expect.objectContaining({engineer:expect.objectContaining({executorProfileId:'ep',permissionPolicyId:'pp'})}));
  });

  it('keeps the saved draft when committing fails', async () => {
    const user = userEvent.setup();
    const commit = vi.fn(async()=>{
      await new Promise((resolve) => setTimeout(resolve, 20));
      return false;
    });
    render(<MemoryRouter><CompanySetupWizard
      profiles={[{id:'ep',name:'Codex',manifestId:'codex-cli',config:{},connection:null}]}
      policies={[{id:'pp',name:'项目安全',approvalStrategy:'ask-by-rule',scope:'project',selectedDirectories:[]}]}
      onPreview={vi.fn(async()=>draft)}
      onCommit={commit}
    /></MemoryRouter>);
    await user.type(screen.getByLabelText(/公司名称/),'Acme');
    await user.type(screen.getByLabelText(/一句话目标/),'发布产品');
    await user.click(screen.getByRole('button',{name:'生成公司蓝图 →'}));
    await user.click(screen.getByRole('button',{name:'继续到运行'}));
    await user.click(screen.getByRole('button',{name:'继续到项目'}));
    await user.click(screen.getByRole('button',{name:'继续到完成'}));
    await user.click(screen.getByRole('button',{name:'按推荐方案创建并进入项目 →'}));
    await waitFor(() => expect(commit).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sessionStorage.getItem('muster:company-setup-draft:v1')).not.toBeNull();
  });
});
