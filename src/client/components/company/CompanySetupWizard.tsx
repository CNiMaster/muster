import type React from 'react';
import { useState } from 'react';
import type { CompanySetupDraft, CompanyTemplateId, SetupBindings } from '../../domain/company-templates';
import { COMPANY_TEMPLATE_OPTIONS } from '../../domain/company-templates';
import type { ExecutorProfileDTO, PermissionPolicyDTO } from '../../hooks/queries';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Card } from '../Card';
import { Field, Input, Select, Textarea } from '../Form';
import { ExecutorReadinessStep } from './ExecutorReadinessStep';

export type SetupStep = 'template' | 'team' | 'executors' | 'project' | 'confirm';
const STEPS: SetupStep[] = ['template', 'team', 'executors', 'project', 'confirm'];
const LABELS: Record<SetupStep, string> = { template: '公司类型', team: '团队', executors: '执行器', project: '项目', confirm: '确认' };

export function CompanySetupWizard({
  profiles,
  policies,
  previewing,
  committing,
  onPreview,
  onCommit,
}: {
  profiles: ExecutorProfileDTO[];
  policies: PermissionPolicyDTO[];
  previewing?: boolean;
  committing?: boolean;
  onPreview: (input: { templateId: CompanyTemplateId; name: string; goal: string }) => Promise<CompanySetupDraft>;
  onCommit: (draft: CompanySetupDraft, bindings: SetupBindings) => Promise<void>;
}): React.ReactElement {
  const [step, setStep] = useState<SetupStep>('template');
  const [templateId, setTemplateId] = useState<CompanyTemplateId>('general');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [draft, setDraft] = useState<CompanySetupDraft | null>(null);
  const [bindings, setBindings] = useState<SetupBindings>({});
  const index = STEPS.indexOf(step);
  const bindingsComplete = Boolean(draft?.employees.every((employee) => bindings[employee.key]?.executorProfileId && bindings[employee.key]?.permissionPolicyId));

  const start = async (): Promise<void> => {
    const next = await onPreview({ templateId, name: name.trim(), goal: goal.trim() });
    setDraft(next);
    setBindings({});
    setStep('team');
  };
  const nextDisabled = step === 'executors' && !bindingsComplete;

  return <div className="form-stack">
    <ol aria-label="创建公司步骤" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, padding: 0, listStyle: 'none' }}>
      {STEPS.map((item, itemIndex) => <li key={item}><Badge tone={item === step ? 'info' : itemIndex < index ? 'ok' : 'neutral'}>{itemIndex + 1}. {LABELS[item]}</Badge></li>)}
    </ol>

    {step === 'template' && <Card title="第一步：选择公司类型与目标"><div className="form-stack">
      <Field label="公司模板"><Select value={templateId} onChange={(event) => setTemplateId(event.target.value as CompanyTemplateId)}>{COMPANY_TEMPLATE_OPTIONS.map((template) => <option key={template.id} value={template.id}>{template.name} — {template.description}</option>)}</Select></Field>
      <Field label="公司名称" required><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Acme 工作室" /></Field>
      <Field label="公司目标" required><Textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="说明这家公司要持续完成什么工作" /></Field>
      <div className="page-actions"><Button loading={previewing} disabled={!name.trim() || !goal.trim()} onClick={() => void start()}>生成团队预览</Button></div>
    </div></Card>}

    {draft && step === 'team' && <Card title="第二步：确认团队"><div className="form-stack">
      {draft.departments.map((department) => <div key={department.key}><strong>{department.name}</strong><ul className="entity-list">{draft.employees.filter((employee) => employee.departmentKey === department.key).map((employee) => <li key={employee.key}>
        <Field label="员工名称"><Input value={employee.name} onChange={(event) => setDraft({ ...draft, employees: draft.employees.map((item) => item.key === employee.key ? { ...item, name: event.target.value } : item) })} /></Field>
        <Field label="岗位"><Input value={employee.role} onChange={(event) => setDraft({ ...draft, employees: draft.employees.map((item) => item.key === employee.key ? { ...item, role: event.target.value } : item) })} /></Field>
        {employee.isLead && <Badge tone="info">第一负责人</Badge>}
      </li>)}</ul></div>)}
    </div></Card>}

    {draft && step === 'executors' && <ExecutorReadinessStep draft={draft} bindings={bindings} profiles={profiles} policies={policies} onChange={setBindings} />}

    {draft && step === 'project' && <Card title="第四步：创建首个项目与项目任务"><div className="form-stack">
      <Field label="项目名称"><Input value={draft.project.name} onChange={(event) => setDraft({ ...draft, project: { ...draft.project, name: event.target.value } })} /></Field>
      <Field label="项目说明"><Textarea value={draft.project.description} onChange={(event) => setDraft({ ...draft, project: { ...draft.project, description: event.target.value } })} /></Field>
      <Field label="首个项目任务"><Input value={draft.firstProjectTask.title} onChange={(event) => setDraft({ ...draft, firstProjectTask: { ...draft.firstProjectTask, title: event.target.value } })} /></Field>
      <Field label="任务目标"><Textarea value={draft.firstProjectTask.brief} onChange={(event) => setDraft({ ...draft, firstProjectTask: { ...draft.firstProjectTask, brief: event.target.value } })} /></Field>
    </div></Card>}

    {draft && step === 'confirm' && <Card title="第五步：确认创建"><div className="form-stack">
      <p><strong>{draft.name}</strong> · {COMPANY_TEMPLATE_OPTIONS.find((item) => item.id === draft.templateId)?.name}</p>
      <p>{draft.employees.length} 位员工 · {draft.departments.length} 个部门 · 项目「{draft.project.name}」</p>
      <p className="muted">创建后直接进入首个项目任务。公司默认保持下班，方便继续调整组织。</p>
    </div></Card>}

    {draft && step !== 'template' && <div className="page-actions" style={{ justifyContent: 'space-between' }}>
      <Button variant="ghost" onClick={() => setStep(STEPS[Math.max(0, index - 1)]!)}>上一步</Button>
      {step === 'confirm' ? <Button loading={committing} onClick={() => void onCommit(draft, bindings)}>创建公司并进入项目</Button> : <Button disabled={nextDisabled} onClick={() => setStep(STEPS[index + 1]!)}>下一步</Button>}
    </div>}
  </div>;
}
