import type React from 'react';
import { useEffect, useState } from 'react';
import type { CompanySetupDraft, CompanyTemplateId, CompanyTemplateOption, SetupBindings } from '../../domain/company-templates';
import { COMPANY_TEMPLATE_OPTIONS } from '../../domain/company-templates';
import type { ExecutorProfileDTO, PermissionPolicyDTO } from '../../hooks/queries';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Card } from '../Card';
import { Field, Input, Textarea } from '../Form';
import { ExecutorReadinessStep } from './ExecutorReadinessStep';
import { CompanyBlueprintReview } from './CompanyBlueprintReview';
import { selectPreferredExecutor } from '../../domain/executor-selection';

export type SetupStep = 'template' | 'team' | 'executors' | 'project' | 'confirm';
const STEPS: SetupStep[] = ['template', 'team', 'executors', 'project', 'confirm'];
const LABELS: Record<SetupStep, string> = { template: '公司', team: '团队', executors: '运行', project: '项目', confirm: '完成' };
const STORAGE_KEY = 'muster:company-setup-draft:v1';

interface SavedState { step: SetupStep; templateId: CompanyTemplateId; name: string; goal: string; draft: CompanySetupDraft | null; bindings: SetupBindings }
function readSavedState(): Partial<SavedState> {
  if (typeof sessionStorage === 'undefined') return {};
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<SavedState>; } catch { return {}; }
}

const TEMPLATE_IMAGES: Record<string, string> = {
  general: '/images/tmpl_general.jpg',
  software: '/images/tmpl_software.jpg',
  content: '/images/tmpl_content.jpg',
  novel: '/images/tmpl_novel.jpg',
  marketing: '/images/tmpl_marketing.jpg',
  consulting: '/images/tmpl_consulting.jpg',
};

export function CompanySetupWizard({ templates = COMPANY_TEMPLATE_OPTIONS, profiles, policies, previewing, committing, refreshingResources, onRefreshResources, onPreview, onCommit }: {
  templates?: CompanyTemplateOption[];
  profiles: ExecutorProfileDTO[];
  policies: PermissionPolicyDTO[];
  previewing?: boolean;
  committing?: boolean;
  refreshingResources?: boolean;
  onRefreshResources?: () => Promise<void>;
  onPreview: (input: { templateId: CompanyTemplateId; name: string; goal: string }) => Promise<CompanySetupDraft>;
  onCommit: (draft: CompanySetupDraft, bindings: SetupBindings) => Promise<boolean>;
}): React.ReactElement {
  const [saved] = useState(readSavedState);
  const [step, setStep] = useState<SetupStep>(saved.step ?? 'template');
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'engineering' | 'creative' | 'business'>('all');
  const [templateId, setTemplateId] = useState<CompanyTemplateId>(saved.templateId ?? templates[0]?.id ?? 'general');
  const [name, setName] = useState(saved.name ?? '');
  const [goal, setGoal] = useState(saved.goal ?? '');
  const [draft, setDraft] = useState<CompanySetupDraft | null>(saved.draft ?? null);
  const [bindings, setBindings] = useState<SetupBindings>(saved.bindings ?? {});
  const index = STEPS.indexOf(step);
  const resourcesReady = profiles.length > 0 && policies.length > 0;
  const preferredExecutor = selectPreferredExecutor(profiles);
  const bindingsComplete = Boolean(draft?.employees.every((employee) => bindings[employee.key]?.executorProfileId && bindings[employee.key]?.permissionPolicyId));

  const visibleTemplates = selectedCategory === 'all'
    ? templates
    : templates.filter((template) => template.category === selectedCategory);

  useEffect(() => {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step, templateId, name, goal, draft, bindings } satisfies SavedState));
  }, [step, templateId, name, goal, draft, bindings]);

  useEffect(() => {
    if (!draft || !resourcesReady) return;
    const executor = selectPreferredExecutor(profiles)!;
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
  const finish = async (): Promise<void> => { if (draft && await onCommit(draft, bindings)) sessionStorage.removeItem(STORAGE_KEY); };

  return <div className="setup-shell">
    <nav className="setup-rail" aria-label="创建公司步骤">
      {STEPS.map((item, itemIndex) => <button key={item} type="button" className={`setup-step ${item === step ? 'is-active' : ''} ${itemIndex < index ? 'is-done' : ''}`} disabled={itemIndex > index || (!draft && itemIndex > 0)} onClick={() => itemIndex <= index && setStep(item)}>
        <span className="setup-step-dot">{itemIndex < index ? '✓' : itemIndex + 1}</span><span>{LABELS[item]}</span>
      </button>)}
    </nav>

    <div className="setup-stage">
      {step === 'template' && <Card className="setup-card" title={<><span className="step-kicker">01</span> 你想组建什么团队？</>}><div className="form-stack">
        <div className="template-categories" style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
          {[
            { key: 'all', label: '全部分类' },
            { key: 'engineering', label: '软件与工程' },
            { key: 'creative', label: '内容与写作' },
            { key: 'business', label: '商业与营销' },
          ].map((cat) => (
            <button
              key={cat.key}
              type="button"
              className={`mu-btn mu-btn-sm ${selectedCategory === cat.key ? 'mu-btn-primary' : 'mu-btn-ghost'}`}
              onClick={() => setSelectedCategory(cat.key as any)}
              style={{ borderRadius: '20px', padding: '4px 14px' }}
            >
              {cat.label}
            </button>
          ))}
        </div>
        <div className="template-grid" role="group" aria-label="公司模板">
          {visibleTemplates.map((template) => {
            const imgSrc = TEMPLATE_IMAGES[template.id];
            return (
              <button key={template.id} type="button" className={`template-choice is-${template.colorToken || 'neutral'} ${template.id === templateId ? 'is-selected' : ''}`} aria-label={`选择${template.name}`} aria-pressed={template.id === templateId} onClick={() => setTemplateId(template.id)}>
                <span className="template-mark" aria-hidden="true" style={{ overflow: 'hidden', padding: 0 }}>
                  {imgSrc ? (
                    <img src={imgSrc} alt={template.name} style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                  ) : (
                    template.mark || template.name.slice(0, 1)
                  )}
                </span>
                <span><strong>{template.name}</strong><small>{template.description}</small></span>
                <span className="template-check" aria-hidden="true">✓</span>
              </button>
            );
          })}
        </div>
        <div className="setup-input-grid"><Field label="公司名称" required><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Acme 工作室" /></Field><Field label="一句话目标" required><Textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="我们要持续完成什么？" /></Field></div>
        <div className={`resource-strip ${resourcesReady ? 'is-ready' : ''}`} aria-live="polite"><span className="resource-orbit" aria-hidden="true"><i/><i/><i/></span><div><strong>{resourcesReady ? '运行环境已准备' : '还差一个执行器'}</strong><small>{resourcesReady ? `将自动使用 ${preferredExecutor!.name} · ${policies[0]!.name}` : '草稿会自动保存，接入后回来刷新即可'}</small></div>{!resourcesReady && <a className="mu-btn mu-btn-subtle mu-btn-sm" href="/executors" target="_blank" rel="noreferrer">接入执行器 ↗</a>}{onRefreshResources && <Button size="sm" variant="ghost" loading={refreshingResources} onClick={() => void onRefreshResources()}>刷新</Button>}</div>
        <div className="setup-primary-actions"><span className="muted">先生成可检查的完整蓝图，确认后再创建；创建后仍可继续调整。</span><Button disabled={!name.trim() || !goal.trim()} loading={previewing} onClick={() => void start()}>生成公司蓝图 →</Button></div>
      </div></Card>}

      {draft && step === 'team' && <Card className="setup-card blueprint-setup-card" title={<><span className="step-kicker">02</span> 公司蓝图已生成，请确认</>} actions={<Badge tone="ok">{draft.employees.length} 人</Badge>}><CompanyBlueprintReview draft={draft} density={draft.presentation.density} onDensityChange={(density) => setDraft({ ...draft, presentation: { ...draft.presentation, density } })} /><details className="details-collapse blueprint-team-editor"><summary>手动调整员工姓名或岗位</summary><div className="edit-team-grid">{draft.employees.map((employee) => <div key={employee.key}><Field label={`${employee.name} · 姓名`}><Input value={employee.name} onChange={(event) => setDraft({ ...draft, employees: draft.employees.map((item) => item.key === employee.key ? { ...item, name: event.target.value } : item) })} /></Field><Field label="岗位"><Input value={employee.role} onChange={(event) => setDraft({ ...draft, employees: draft.employees.map((item) => item.key === employee.key ? { ...item, role: event.target.value } : item) })} /></Field></div>)}</div></details></Card>}

      {draft && step === 'executors' && <ExecutorReadinessStep draft={draft} bindings={bindings} profiles={profiles} policies={policies} onChange={setBindings} onRefresh={onRefreshResources} refreshing={refreshingResources} />}

      {draft && step === 'project' && <Card className="setup-card" title={<><span className="step-kicker">04</span> 第一份工作</>}><div className="project-flow"><div className="project-flow-node"><span aria-hidden="true">▣</span><strong>项目</strong><Field label="项目名称"><Input value={draft.project.name} onChange={(event) => setDraft({ ...draft, project: { ...draft.project, name: event.target.value } })} /></Field><Field label="项目说明"><Textarea value={draft.project.description} onChange={(event) => setDraft({ ...draft, project: { ...draft.project, description: event.target.value } })} /></Field></div><div className="project-flow-arrow" aria-hidden="true">→</div><div className="project-flow-node"><span aria-hidden="true">✓</span><strong>项目任务</strong><Field label="任务标题"><Input value={draft.firstProjectTask.title} onChange={(event) => setDraft({ ...draft, firstProjectTask: { ...draft.firstProjectTask, title: event.target.value } })} /></Field><Field label="完成标准"><Textarea value={draft.firstProjectTask.brief} onChange={(event) => setDraft({ ...draft, firstProjectTask: { ...draft.firstProjectTask, brief: event.target.value } })} /></Field></div></div></Card>}

      {draft && step === 'confirm' && <Card className="setup-card setup-finish" title={<><span className="step-kicker">05</span> 准备完成</>}><div className="launch-preview"><div className="launch-ring" aria-hidden="true"><span>{draft.name.slice(0, 1)}</span></div><h2>{draft.name}</h2><p>{draft.employees.length} 位员工 · {draft.departments.length} 个部门</p><div className="launch-path"><span>公司</span><i>→</i><span>{draft.project.name}</span><i>→</i><span>{draft.firstProjectTask.title}</span></div><small>创建后先保持待命，你确认运行配置后再启动公司。</small></div></Card>}

      {draft && step !== 'template' && <footer className="setup-footer"><Button variant="ghost" onClick={() => setStep(STEPS[Math.max(0, index - 1)]!)}>← 返回{LABELS[STEPS[Math.max(0, index - 1)]!]}</Button><span>{index + 1} / {STEPS.length}</span>{step === 'confirm' ? <Button loading={committing} onClick={() => void finish()}>按推荐方案创建并进入项目 →</Button> : <Button disabled={(step === 'team' && draft.healthFindings.some((finding) => finding.severity === 'blocking')) || (step === 'executors' && !bindingsComplete)} onClick={() => setStep(STEPS[index + 1]!)}>继续到{LABELS[STEPS[index + 1]!]}</Button>}</footer>}
    </div>
  </div>;
}
