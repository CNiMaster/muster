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
} from '../hooks/queries';

export function CompanyWizardPage(): React.ReactElement {
  const navigate = useNavigate();
  const preview = usePreviewCompanySetup();
  const commit = useCommitCompanySetup();
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
      toast('success', '公司、团队和首个项目任务已创建');
      navigate(`/projects/${result.project.id}?projectTask=${result.projectTask.id}&onboarding=done`);
      return true;
    } catch (error) {
      toast('error', (error as Error).message);
      return false;
    }
  };

  return <div className="wizard-page">
    <header className="setup-hero"><div><span className="setup-hero-mark" aria-hidden="true">M</span><div><h1>组建你的 Agent 公司</h1><p>选一个模板，剩下的交给 Muster。</p></div></div><Link to="/" className="setup-close" aria-label="退出公司创建">×</Link></header>
    <CompanySetupWizard
      templates={templatesQuery.data}
      profiles={profiles}
      policies={policies}
      previewing={preview.isPending}
      committing={commit.isPending}
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
    />
  </div>;
}
