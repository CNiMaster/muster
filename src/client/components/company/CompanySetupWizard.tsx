import type React from 'react';
import { useEffect, useState } from 'react';
import type { CompanySetupDraft, CompanyTemplateId, SetupBindings } from '../../domain/company-templates';
import { COMPANY_TEMPLATE_OPTIONS } from '../../domain/company-templates';
import type { ExecutorProfileDTO, PermissionPolicyDTO } from '../../hooks/queries';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Card } from '../Card';
import { Field, Input, Textarea } from '../Form';
import { ExecutorReadinessStep } from './ExecutorReadinessStep';

export type SetupStep = 'template' | 'team' | 'executors' | 'project' | 'confirm';
const STEPS: SetupStep[] = ['template', 'team', 'executors', 'project', 'confirm'];
const LABELS: Record<SetupStep, string> = { template: '公司', team: '团队', executors: '运行', project: '项目', confirm: '完成' };
const TEMPLATE_MARKS: Record<CompanyTemplateId, { symbol: string; color: string }> = {
  general: { symbol: '◎', color: 'blue' },
  software: { symbol: '</>', color: 'orange' },
  content: { symbol: '✦', color: 'green' },
  novel: { symbol: '¶', color: 'red' },
};
const STORAGE_KEY = 'muster:company-setup-draft:v1';

interface SavedState { step: SetupStep; templateId: CompanyTemplateId; name: string; goal: string; draft: CompanySetupDraft | null; bindings: SetupBindings }
function readSavedState(): Partial<SavedState> {
  if (typeof sessionStorage === 'undefined') return {};
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<SavedState>; } catch { return {}; }
}

export function CompanySetupWizard({ profiles, policies, previewing, committing, refreshingResources, onRefreshResources, onPreview, onCommit }: {
  profiles: ExecutorProfileDTO[];
  policies: PermissionPolicyDTO[];
  previewing?: boolean;
  committing?: boolean;
  refreshingResources?: boolean;
  onRefreshResources?: () => Promise<void>;
  onPreview: (input: { templateId: CompanyTemplateId; name: string; goal: string }) => Promise<CompanySetupDraft>;
  onCommit: (draft: CompanySetupDraft, bindings: SetupBindings) => Promise<void>;
}): React.ReactElement {
  const [saved] = useState(readSavedState);
  const [step, setStep] = useState<SetupStep>(saved.step ?? 'template');
  const [templateId, setTemplateId] = useState<CompanyTemplateId>(saved.templateId ?? 'general');
  const [name, setName] = useState(saved.name ?? '');
  const [goal, setGoal] = useState(saved.goal ?? '');
  const [draft, setDraft] = useState<CompanySetupDraft | null>(saved.draft ?? null);
  const [bindings, setBindings] = useState<SetupBindings>(saved.bindings ?? {});
  const index = STEPS.indexOf(step);
  const resourcesReady = profiles.length > 0 && policies.length > 0;
  const bindingsComplete = Boolean(draft?.employees.every((employee) => bindings[employee.key]?.executorProfileId && bindings[employee.key]?.permissionPolicyId));

  useEffect(() => {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step, templateId, name, goal, draft, bindings } satisfies SavedState));
  }, [step, templateId, name, goal, draft, bindings]);

  useEffect(() => {
    if (!draft || !resourcesReady) return;
    const executor = profiles.find((profile) => profile.connection?.status === 'connected') ?? profiles[0]!;
    const policy = policies[0]!;
    setBindings((current) => {
      let changed = false;
      const next = { ...current };
      for (const employee of draft.employees) {
        if (!next[employee.key]?.executorProfileId || !next[employee.key]?.permissionPolicyId) {
          next[employee.key] = { executorProfileId: next[employee.key]?.executorProfileId || executor.id, permissionPolicyId: next[employee.key]?.permissionPolicyId || policy.id };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [draft, profiles, policies, resourcesReady]);

  const previewDraft = async (): Promise<CompanySetupDraft> => {
    const next = await onPreview({ templateId, name: name.trim(), goal: goal.trim() });
    setDraft(next);
    return next;
  };
  const start = async (): Promise<void> => { await previewDraft(); setStep('team'); };
  const quickStart = async (): Promise<void> => {
    if (!resourcesReady) return;
    const next = await previewDraft();
    const executor = profiles.find((profile) => profile.connection?.status === 'connected') ?? profiles[0]!;
    const policy = policies[0]!;
    const quickBindings = Object.fromEntries(next.employees.map((employee) => [employee.key, { executorProfileId: executor.id, permissionPolicyId: policy.id }]));
    setBindings(quickBindings);
    await onCommit(next, quickBindings);
    sessionStorage.removeItem(STORAGE_KEY);
  };
  const finish = async (): Promise<void> => { if (draft) { await onCommit(draft, bindings); sessionStorage.removeItem(STORAGE_KEY); } };

  return <div className="setup-shell">
    <nav className="setup-rail" aria-label="创建公司步骤">
      {STEPS.map((item, itemIndex) => <button key={item} type="button" className={`setup-step ${item === step ? 'is-active' : ''} ${itemIndex < index ? 'is-done' : ''}`} disabled={itemIndex > index || (!draft && itemIndex > 0)} onClick={() => itemIndex <= index && setStep(item)}>
        <span className="setup-step-dot">{itemIndex < index ? '✓' : itemIndex + 1}</span><span>{LABELS[item]}</span>
      </button>)}
    </nav>

    <div className="setup-stage">
      {step === 'template' && <Card className="setup-card" title={<><span className="step-kicker">01</span> 你想组建什么团队？</>}><div className="form-stack">
        <div className="template-grid" role="group" aria-label="公司模板">
          {COMPANY_TEMPLATE_OPTIONS.map((template) => <button key={template.id} type="button" className={`template-choice is-${TEMPLATE_MARKS[template.id].color} ${template.id === templateId ? 'is-selected' : ''}`} aria-label={`选择${template.name}`} aria-pressed={template.id === templateId} onClick={() => setTemplateId(template.id)}>
            <span className="template-mark" aria-hidden="true">{TEMPLATE_MARKS[template.id].symbol}</span>
            <span><strong>{template.name}</strong><small>{template.description}</small></span>
            <span className="template-check" aria-hidden="true">✓</span>
          </button>)}
        </div>
        <div className="setup-input-grid"><Field label="公司名称" required><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Acme 工作室" /></Field><Field label="一句话目标" required><Textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="我们要持续完成什么？" /></Field></div>
        <div className={`resource-strip ${resourcesReady ? 'is-ready' : ''}`} aria-live="polite"><span className="resource-orbit" aria-hidden="true"><i/><i/><i/></span><div><strong>{resourcesReady ? '运行环境已准备' : '还差一个执行器'}</strong><small>{resourcesReady ? `将自动使用 ${profiles[0]!.name} · ${policies[0]!.name}` : '草稿会自动保存，接入后回来刷新即可'}</small></div>{!resourcesReady && <a className="mu-btn mu-btn-subtle mu-btn-sm" href="/executors" target="_blank" rel="noreferrer">接入执行器 ↗</a>}{onRefreshResources && <Button size="sm" variant="ghost" loading={refreshingResources} onClick={() => void onRefreshResources()}>刷新</Button>}</div>
        <div className="setup-primary-actions"><Button variant="ghost" disabled={!name.trim() || !goal.trim()} loading={previewing} onClick={() => void start()}>先看看团队</Button><Button disabled={!resourcesReady || !name.trim() || !goal.trim()} loading={previewing || committing} onClick={() => void quickStart()}>一键创建并进入项目 →</Button></div>
      </div></Card>}

      {draft && step === 'team' && <Card className="setup-card" title={<><span className="step-kicker">02</span> 团队已经排好</>} actions={<Badge tone="ok">{draft.employees.length} 人</Badge>}><div className="org-preview">
        {draft.departments.map((department) => <section key={department.key} className="org-column"><strong>{department.name}</strong><div>{draft.employees.filter((employee) => employee.departmentKey === department.key).map((employee) => <span key={employee.key} className="person-chip"><b>{employee.name.slice(0, 1)}</b><span>{employee.name}<small>{employee.role}</small></span>{employee.isLead && <i>负责人</i>}</span>)}</div></section>)}
      </div><details className="details-collapse"><summary>调整姓名或岗位</summary><div className="edit-team-grid">{draft.employees.map((employee) => <div key={employee.key}><Field label={`${employee.name} · 姓名`}><Input value={employee.name} onChange={(event) => setDraft({ ...draft, employees: draft.employees.map((item) => item.key === employee.key ? { ...item, name: event.target.value } : item) })} /></Field><Field label="岗位"><Input value={employee.role} onChange={(event) => setDraft({ ...draft, employees: draft.employees.map((item) => item.key === employee.key ? { ...item, role: event.target.value } : item) })} /></Field></div>)}</div></details></Card>}

      {draft && step === 'executors' && <ExecutorReadinessStep draft={draft} bindings={bindings} profiles={profiles} policies={policies} onChange={setBindings} onRefresh={onRefreshResources} refreshing={refreshingResources} />}

      {draft && step === 'project' && <Card className="setup-card" title={<><span className="step-kicker">04</span> 第一份工作</>}><div className="project-flow"><div className="project-flow-node"><span aria-hidden="true">▣</span><strong>项目</strong><Field label="项目名称"><Input value={draft.project.name} onChange={(event) => setDraft({ ...draft, project: { ...draft.project, name: event.target.value } })} /></Field><Field label="项目说明"><Textarea value={draft.project.description} onChange={(event) => setDraft({ ...draft, project: { ...draft.project, description: event.target.value } })} /></Field></div><div className="project-flow-arrow" aria-hidden="true">→</div><div className="project-flow-node"><span aria-hidden="true">✓</span><strong>项目任务</strong><Field label="任务标题"><Input value={draft.firstProjectTask.title} onChange={(event) => setDraft({ ...draft, firstProjectTask: { ...draft.firstProjectTask, title: event.target.value } })} /></Field><Field label="完成标准"><Textarea value={draft.firstProjectTask.brief} onChange={(event) => setDraft({ ...draft, firstProjectTask: { ...draft.firstProjectTask, brief: event.target.value } })} /></Field></div></div></Card>}

      {draft && step === 'confirm' && <Card className="setup-card setup-finish" title={<><span className="step-kicker">05</span> 准备完成</>}><div className="launch-preview"><div className="launch-ring" aria-hidden="true"><span>{draft.name.slice(0, 1)}</span></div><h2>{draft.name}</h2><p>{draft.employees.length} 位员工 · {draft.departments.length} 个部门</p><div className="launch-path"><span>公司</span><i>→</i><span>{draft.project.name}</span><i>→</i><span>{draft.firstProjectTask.title}</span></div><small>创建后先保持待命，你确认运行配置后再启动公司。</small></div></Card>}

      {draft && step !== 'template' && <footer className="setup-footer"><Button variant="ghost" onClick={() => setStep(STEPS[Math.max(0, index - 1)]!)}>← 返回</Button><span>{index + 1} / {STEPS.length}</span>{step === 'confirm' ? <Button loading={committing} onClick={() => void finish()}>创建并进入项目 →</Button> : <Button disabled={step === 'executors' && !bindingsComplete} onClick={() => setStep(STEPS[index + 1]!)}>继续 →</Button>}</footer>}
    </div>
  </div>;
}
