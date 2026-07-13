import type React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, toast } from '../components/Button';
import { CompanySetupWizard } from '../components/company/CompanySetupWizard';
import type { CompanySetupDraft, SetupBindings } from '../domain/company-templates';
import {
  useCommitCompanySetup,
  useCreatePermissionPolicy,
  useExecutorProfiles,
  usePermissionPolicies,
  usePreviewCompanySetup,
} from '../hooks/queries';

export function CompanyWizardPage(): React.ReactElement {
  const navigate = useNavigate();
  const preview = usePreviewCompanySetup();
  const commit = useCommitCompanySetup();
  const { data: profiles = [] } = useExecutorProfiles();
  const { data: policies = [] } = usePermissionPolicies();
  const createPolicy = useCreatePermissionPolicy();

  const finish = async (draft: CompanySetupDraft, bindings: SetupBindings): Promise<void> => {
    try {
      const result = await commit.mutateAsync({ draft, bindings });
      toast('success', '公司、团队和首个项目任务已创建');
      navigate(`/projects/${result.project.id}?projectTask=${result.projectTask.id}&onboarding=done`);
    } catch (error) {
      toast('error', (error as Error).message);
    }
  };

  return <div className="wizard-page" style={{ maxWidth: 960, margin: '0 auto', padding: 'var(--space-5) 0' }}>
    <header className="page-header">
      <div><h1>创建 Agent 公司</h1><p className="subtitle">选择模板、确认团队、绑定执行器与权限，再创建首个项目任务。</p></div>
      <div className="page-actions">
        {!profiles.length && <Link className="mu-btn mu-btn-subtle" to="/executors">接入执行器</Link>}
        {!policies.length && <Button variant="ghost" loading={createPolicy.isPending} onClick={() => createPolicy.mutate({ name: '项目内按规则询问', approvalStrategy: 'ask-by-rule', scope: 'project' }, {
          onSuccess: () => toast('success', '默认项目权限已创建'),
          onError: (error) => toast('error', (error as Error).message),
        })}>创建默认权限</Button>}
      </div>
    </header>
    <CompanySetupWizard
      profiles={profiles}
      policies={policies}
      previewing={preview.isPending}
      committing={commit.isPending}
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
