import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Company } from '../../api/types';
import { useCompanyCredentials, useDismissTemplateHealthFinding, useRefreshTemplateHealth, useSetCompanyCredential, useTemplateHealthFindings, useUpdateCompany } from '../../hooks/queries';
import { Button, toast } from '../Button';
import { Card } from '../Card';
import { Field, Input } from '../Form';
import { Badge } from '../Badge';
import { TemplateHealthPanel } from './TemplateHealthPanel';
import { CompanyAutomation } from './CompanyAutomation';

const INPUT_FIELDS = [
  { key: 'goal', label: '目标' },
  { key: 'background', label: '背景' },
  { key: 'references', label: '引用资料' },
  { key: 'acceptance', label: '验收标准' },
];
const OUTPUT_FIELDS = [
  { key: 'summary', label: '结论摘要' },
  { key: 'deliverables', label: '交付物' },
  { key: 'risks', label: '风险与阻塞' },
  { key: 'nextActions', label: '下一步' },
];

export function CompanySettings({ company }: { company: Company }): React.ReactElement {
  const updateCompany = useUpdateCompany();
  const health = useTemplateHealthFindings(company.id);
  const refreshHealth = useRefreshTemplateHealth();
  const dismissHealth = useDismissTemplateHealthFinding();
  const savedProtocol = (company.contractJson.taskProtocol ?? {}) as { inputFields?: string[]; outputFields?: string[] };
  const [inputFields, setInputFields] = useState(savedProtocol.inputFields ?? []);
  const [outputFields, setOutputFields] = useState(savedProtocol.outputFields ?? []);
  const toggle = (values: string[], key: string, setValues: (next: string[]) => void): void => setValues(values.includes(key) ? values.filter((value) => value !== key) : [...values, key]);
  const saveProtocol = (): void => {
    updateCompany.mutate({
      id: company.id,
      contractJson: { ...company.contractJson, taskProtocol: { version: 1, inputFields, outputFields } },
    }, {
      onSuccess: () => toast('success', '任务交接格式已保存'),
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  return <div className="form-stack company-settings-surface">
    <TemplateHealthPanel findings={health.data ?? []} refreshing={refreshHealth.isPending || health.isLoading} onRefresh={() => refreshHealth.mutate(company.id)} onDismiss={(findingId) => dismissHealth.mutate({ companyId: company.id, findingId })} />
    <Card id="collaboration-rules" title="组织与协作规则">
      <div className="collaboration-rule-grid">
        <Link to={`/companies/${company.id}/graphs/org`}><span aria-hidden="true">组</span><strong>上下级关系</strong><small>谁负责谁、向谁上报</small></Link>
        <Link to={`/companies/${company.id}/graphs/communication`}><span aria-hidden="true">联</span><strong>智能体引用关系</strong><small>谁可以找谁协作</small></Link>
        <Link to={`/companies/${company.id}/workflows/main`}><span aria-hidden="true">流</span><strong>智能体协作流程</strong><small>谁接单、交给谁、由谁验收</small></Link>
        <Link to={`/companies/${company.id}?view=team`}><span aria-hidden="true">岗</span><strong>岗位职责</strong><small>能力、权限与任职配置</small></Link>
      </div>
    </Card>

    <Card title="任务交接格式" actions={<Button size="sm" onClick={saveProtocol} loading={updateCompany.isPending}>保存</Button>}>
      {!savedProtocol.inputFields && <p className="muted">该工作台尚未保存交接标准。选择字段并保存后，新任务会自动带上这些要求。</p>}
      <div className="task-protocol-builder">
        <fieldset><legend>派发工作时应包含</legend><div>{INPUT_FIELDS.map((field) => <label key={field.key} className={inputFields.includes(field.key) ? 'is-selected' : ''}><input type="checkbox" checked={inputFields.includes(field.key)} onChange={() => toggle(inputFields, field.key, setInputFields)} /><span>{field.label}</span></label>)}</div></fieldset>
        <span className="protocol-arrow" aria-hidden="true">→</span>
        <fieldset><legend>智能体完成时应返回</legend><div>{OUTPUT_FIELDS.map((field) => <label key={field.key} className={outputFields.includes(field.key) ? 'is-selected' : ''}><input type="checkbox" checked={outputFields.includes(field.key)} onChange={() => toggle(outputFields, field.key, setOutputFields)} /><span>{field.label}</span></label>)}</div></fieldset>
      </div>
    </Card>

    <Card title="工作台章程">
      {company.charter ? <pre className="charter">{company.charter}</pre> : <p className="muted">尚未设置工作台章程。</p>}
    </Card>
    <Card title="目录与沙盒说明">
      <div className="dir-explain-list">
        <div className="dir-explain-item"><span className="dir-explain-tag">工作区</span><div><strong>Workspace</strong><p className="muted">默认项目目录的父容器，可在「设置」中切换激活工作区。一个工作区可容纳多家工作台、多个项目。</p></div></div>
        <div className="dir-explain-item"><span className="dir-explain-tag">项目目录</span><div><strong>project.rootDir</strong><p className="muted">每个项目独立的正式目录（自带 git 仓库）。一个工作台可同时运行多个项目，每个项目目录互不影响。在「项目」列表中可查看和迁移。</p></div></div>
        <div className="dir-explain-item"><span className="dir-explain-tag">执行沙盒</span><div><strong>~/.muster/worktrees/&lt;taskId&gt;</strong><p className="muted">每个任务执行时基于项目目录创建的临时隔离 worktree。Agent 不直接改正式目录，成果经发布合并回项目目录。任务结束自动清理。</p></div></div>
      </div>
    </Card>
    <CompanyAutomation companyId={company.id} />
    <CompanyCredentialCard companyId={company.id} />
    <Card title="执行环境">
      <div className="settings-link-row"><Link className="mu-btn mu-btn-subtle" to="/executors">执行器中心</Link><Link className="mu-btn mu-btn-subtle" to="/permissions">权限中心</Link></div>
    </Card>
  </div>;
}

/**
 * 工作台级凭据派发卡片(三层解析的工作台层入口)。
 * 展示从平台默认派发到本工作台的凭据清单,支持工作台级环境变量覆盖与启停。
 * 解析优先级:智能体覆盖 > 工作台覆盖(此处) > 平台默认 > 系统回退。
 */
function CompanyCredentialCard({ companyId }: { companyId: string }): React.ReactElement {
  const { data: creds, isLoading } = useCompanyCredentials(companyId);
  const setCred = useSetCompanyCredential();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState('');

  const startEdit = (id: string, current: string | null): void => {
    setEditingId(id);
    setDraftKey(current ?? '');
  };

  const saveOverride = (definitionId: string): void => {
    setCred.mutate(
      { companyId, definitionId, overrideKey: draftKey.trim() || null },
      {
        onSuccess: () => { toast('success', '工作台级凭据覆盖已保存'); setEditingId(null); },
        onError: (e) => toast('error', (e as Error).message ?? '保存失败'),
      },
    );
  };

  const toggleEnabled = (definitionId: string, enabled: boolean): void => {
    setCred.mutate(
      { companyId, definitionId, enabled: !enabled },
      {
        onSuccess: () => toast('success', !enabled ? '已禁用' : '已启用'),
        onError: (e) => toast('error', (e as Error).message ?? '操作失败'),
      },
    );
  };

  return (
    <Card title="工作台凭据派发" actions={<Link className="mu-btn mu-btn-subtle mu-btn-sm" to="/settings?view=credentials">平台凭据库</Link>}>
      <p className="muted">执行时按"智能体覆盖 → 工作台覆盖 → 平台默认 → 系统环境"逐层解析。留空表示用平台默认环境变量名。</p>
      {isLoading && <p className="muted">加载中…</p>}
      {!isLoading && (!creds || creds.length === 0) && <p className="muted">本工作台未派发任何凭据。</p>}
      {creds && creds.length > 0 && (
        <div className="form-stack">
          {creds.map((c) => (
            <div key={c.credentialDefinitionId} className="tool-capability-group">
              <div className="tool-item-head">
                <span className="tool-item-title">
                  {c.definition.name}
                  <Badge tone={c.enabled ? 'ok' : 'err'}>{c.enabled ? '启用' : '禁用'}</Badge>
                  {c.definition.isDefault && <Badge tone="neutral">平台默认</Badge>}
                </span>
                <div className="tool-item-actions">
                  <Button variant="ghost" onClick={() => toggleEnabled(c.credentialDefinitionId, c.enabled)}>
                    {c.enabled ? '禁用' : '启用'}
                  </Button>
                </div>
              </div>
              <div className="tool-item-meta">
                <span className="muted">平台默认: <code>{c.definition.credentialKey}</code></span>
                <span className="muted">类别: {c.definition.category}</span>
              </div>
              {editingId === c.credentialDefinitionId ? (
                <div className="settings-field-grid" style={{ marginTop: 'var(--space-2)' }}>
                  <Field label="工作台级环境变量覆盖(留空用平台默认)">
                    <Input value={draftKey} onChange={(e) => setDraftKey(e.target.value)} placeholder={c.definition.credentialKey} />
                  </Field>
                  <div className="settings-primary-actions">
                    <Button variant="ghost" onClick={() => setEditingId(null)}>取消</Button>
                    <Button onClick={() => saveOverride(c.credentialDefinitionId)} loading={setCred.isPending}>保存</Button>
                  </div>
                </div>
              ) : (
                <div className="material-meta">
                  <span className="muted">生效: <code>{c.overrideKey ?? c.definition.credentialKey}</code></span>
                  <Button variant="ghost" onClick={() => startEdit(c.credentialDefinitionId, c.overrideKey)}>覆盖</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
