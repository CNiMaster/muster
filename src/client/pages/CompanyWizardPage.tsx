import type React from 'react';
import { useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from '../components/Button';
import { CompanySetupWizard } from '../components/company/CompanySetupWizard';
import type { CompanySetupDraft, SetupBindings } from '../domain/company-templates';
import {
  useCommitCompanySetup,
  useCompanyTemplateCatalog,
  useCreatePermissionPolicy,
  useExecutorProfiles,
  usePermissionPolicies,
  usePreviewCompanySetup,
  useQuickStartCompany,
} from '../hooks/queries';

export function CompanyWizardPage(): React.ReactElement {
  const navigate = useNavigate();
  const preview = usePreviewCompanySetup();
  const commit = useCommitCompanySetup();
  const quickStart = useQuickStartCompany();
  const templatesQuery = useCompanyTemplateCatalog();
  const profilesQuery = useExecutorProfiles();
  const policiesQuery = usePermissionPolicies();
  const profiles = profilesQuery.data ?? [];
  const policies = policiesQuery.data ?? [];
  const createPolicy = useCreatePermissionPolicy();
  const policyAttempted = useRef(false);

  useEffect(() => {
    if (policiesQuery.isLoading || policies.length || policyAttempted.current) return;
    policyAttempted.current = true;
    createPolicy.mutate({ name: '项目内按规则询问', approvalStrategy: 'ask-by-rule', scope: 'project' });
  }, [policiesQuery.isLoading, policies.length]);

  const finish = async (draft: CompanySetupDraft, bindings: SetupBindings): Promise<boolean> => {
    try {
      const result = await commit.mutateAsync({ draft, bindings });
      toast('success', '工作台、团队和首个项目任务已创建');
      navigate(`/projects/${result.project.id}?projectTask=${result.projectTask.id}&onboarding=done`);
      return true;
    } catch (error) {
      toast('error', (error as Error).message);
      return false;
    }
  };

  // 工作台改版 批次 1：一键开跑——跳过蓝图确认，直接进工作台对话。
  const quickFinish = async (input: { templateId: string; name?: string; goal?: string }): Promise<boolean> => {
    try {
      const result = await quickStart.mutateAsync(input);
      toast('success', `「${result.company.name}」已就绪，开始对话吧`);
      // 改版 2a：落地工作台对话中心。
      navigate(`/companies/${result.company.id}?view=conversation`);
      return true;
    } catch (error) {
      toast('error', (error as Error).message);
      return false;
    }
  };

  return <div className="wizard-page">
    <header className="setup-hero"><div><span className="setup-hero-mark" aria-hidden="true">M</span><div><h1>组建你的 Agent 工作台</h1><p>选一个模板，剩下的交给 Muster。</p></div></div><Link to="/" className="setup-close" aria-label="退出工作台创建">×</Link></header>
    <CompanySetupWizard
      templates={templatesQuery.data}
      profiles={profiles}
      policies={policies}
      previewing={preview.isPending}
      committing={commit.isPending}
      quickStarting={quickStart.isPending}
      refreshingResources={profilesQuery.isRefetching || policiesQuery.isRefetching}
      onRefreshResources={async () => { await Promise.all([profilesQuery.refetch(), policiesQuery.refetch()]); }}
      onPreview={async (input) => {
        try {
          return await preview.mutateAsync(input);
        } catch (error) {
          toast('error', (error as Error).message);
          throw error;
        }
      }}
      onCommit={finish}
      onQuickStart={quickFinish}
    />
  </div>;
}
