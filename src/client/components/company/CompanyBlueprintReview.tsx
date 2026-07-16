import type React from 'react';
import type { CompanySetupDraft } from '../../domain/company-templates';
import { Badge } from '../Badge';

type BlueprintDensity = CompanySetupDraft['presentation']['density'];

const DENSITY_OPTIONS: Array<{ id: BlueprintDensity; label: string }> = [
  { id: 'guided', label: '引导显示' },
  { id: 'compact', label: '紧凑显示' },
  { id: 'visual', label: '图形显示' },
];

export function CompanyBlueprintReview({ draft, density, onDensityChange }: {
  draft: CompanySetupDraft;
  density: BlueprintDensity;
  onDensityChange: (density: BlueprintDensity) => void;
}): React.ReactElement {
  const employeeByRole = new Map(draft.employees.map((employee) => [employee.role, employee]));
  const blocking = draft.healthFindings.filter((finding) => finding.severity === 'blocking').length;

  return <div className={`blueprint-review is-${density}`}>
    <header className="blueprint-hero">
      <span className={`blueprint-mark is-${draft.presentation.colorToken}`} aria-hidden="true">{draft.presentation.mark}</span>
      <div>
        <div className="blueprint-eyebrow"><Badge tone={draft.generation.source === 'template_architect' ? 'info' : 'neutral'}>{draft.generation.source === 'template_architect' ? '智能生成蓝图' : '推荐模板蓝图'}</Badge>{blocking > 0 && <Badge tone="err">{blocking} 个阻断问题</Badge>}</div>
        <h2>{draft.name}</h2>
        <p>{draft.summary.positioning}</p>
      </div>
      <div className="blueprint-density" role="group" aria-label="蓝图显示密度">
        {DENSITY_OPTIONS.map((option) => <button key={option.id} type="button" aria-label={option.label} aria-pressed={density === option.id} className={density === option.id ? 'is-active' : ''} onClick={() => onDensityChange(option.id)}>{option.label.replace('显示', '')}</button>)}
      </div>
    </header>

    {draft.generation.warning && <div className="blueprint-generation-warning" role="status">{draft.generation.warning}</div>}

    <div className="blueprint-modules">
      <article className="blueprint-module blueprint-overview">
        <div className="blueprint-module-head"><span>01</span><h3>公司概览</h3></div>
        <p className="blueprint-lead">{draft.summary.operatingModel}</p>
        <div className="blueprint-deliverables">{draft.summary.deliverables.map((item) => <span key={item}>{item}</span>)}</div>
        <dl><div><dt>公司目标</dt><dd>{draft.goal}</dd></div><div><dt>首个项目</dt><dd>{draft.project.name}</dd></div><div><dt>第一份工作</dt><dd>{draft.firstProjectTask.title}</dd></div></dl>
      </article>

      <article className="blueprint-module">
        <div className="blueprint-module-head"><span>02</span><h3>团队与责任</h3></div>
        <div className="blueprint-departments">{draft.departments.map((department) => <section key={department.key}>
          <strong>{department.name}</strong>
          {draft.employees.filter((employee) => employee.departmentKey === department.key).map((employee) => <div key={employee.key} className="blueprint-person">
            <b>{employee.name.slice(0, 1)}</b><span><strong>{employee.name}</strong><small>{employee.responsibilities}</small></span>{employee.isLead && <Badge tone="info">第一负责人</Badge>}
          </div>)}
        </section>)}</div>
        <p className="blueprint-footnote">已配置 {draft.relationships.org.length} 条负责关系、{draft.relationships.communication.length} 条通信规则。</p>
      </article>

      <article className="blueprint-module">
        <div className="blueprint-module-head"><span>03</span><h3>业务信息中心</h3></div>
        <div className="blueprint-record-grid">{draft.knowledgeModel.recordTypes.map((record) => {
          const ownerRoles = [...new Set(record.fields.map((definition) => definition.maintenance.ownerRoleKey))];
          return <section key={record.key} className="blueprint-record">
            <div><strong>{record.label}</strong><Badge tone="neutral">{record.fields.length} 个字段</Badge></div>
            <p>{record.description}</p>
            <small>负责人：{ownerRoles.map((role) => employeeByRole.get(role)?.name ?? role).join('、')}</small>
          </section>;
        })}</div>
        <div className="blueprint-view-list"><strong>默认看板</strong>{draft.knowledgeModel.views.map((view) => <span key={view.key}>{view.label}<small>{viewKindLabel(view.kind)}</small></span>)}</div>
      </article>

      <article className="blueprint-module">
        <div className="blueprint-module-head"><span>04</span><h3>工作如何流转</h3></div>
        <div className="blueprint-flow" aria-label="主要工作流">{draft.workflow.nodes.map((node, index) => <div key={node.key} className={`blueprint-flow-node is-${node.kind}`}><span>{node.label}</span>{index < draft.workflow.nodes.length - 1 && <i aria-hidden="true">→</i>}</div>)}</div>
        <div className="blueprint-automations">{draft.automations.map((automation) => <section key={automation.key}><span aria-hidden="true">↻</span><div><strong>{automation.label}</strong><small>{automation.description} · 由 {employeeByRole.get(automation.targetRoleKey)?.name ?? automation.targetRoleKey} 负责</small></div></section>)}</div>
      </article>

      <article className="blueprint-module">
        <div className="blueprint-module-head"><span>05</span><h3>能力与运行条件</h3></div>
        <div className="blueprint-capabilities">{draft.capabilityBindings.map((binding) => {
          const employee = employeeByRole.get(binding.roleKey);
          return <section key={`${binding.roleKey}:${binding.capabilityId}`}>
            <div><strong>{binding.label}</strong><span>{employee?.name ?? binding.roleKey}</span></div>
            <p>{binding.purpose}</p>
            <small>何时使用：{binding.loadWhen}</small>
            <div className="blueprint-skill-list">{binding.skillIds.length > 0 ? binding.skillIds.map((skill) => <Badge key={skill} tone="info">{skill}</Badge>) : <Badge tone="neutral">按岗位协议执行</Badge>}</div>
          </section>;
        })}</div>
        <p className="blueprint-footnote">Skill 由对应员工在相关 Task 中按需加载，不会把全部能力注入所有员工。</p>
      </article>

      <article className="blueprint-module">
        <div className="blueprint-module-head"><span>06</span><h3>风险与建议</h3></div>
        {draft.healthFindings.length === 0 ? <div className="blueprint-health-ok"><span aria-hidden="true">✓</span><div><strong>蓝图结构完整</strong><small>负责人、字段、视图和流程引用均可用。</small></div></div> : <div className="blueprint-findings">{draft.healthFindings.map((finding) => <section key={finding.id} className={`is-${finding.severity}`}>
          <div><Badge tone={finding.severity === 'blocking' ? 'err' : finding.severity === 'warning' ? 'warn' : 'neutral'}>{finding.severity === 'blocking' ? '必须处理' : finding.severity === 'warning' ? '建议处理' : '提示'}</Badge><strong>{finding.title}</strong></div>
          <dl><div><dt>发生了什么</dt><dd>{finding.message}</dd></div><div><dt>会影响什么</dt><dd>{finding.impact}</dd></div><div><dt>推荐处理</dt><dd>{finding.recommendation}</dd></div></dl>
        </section>)}</div>}
      </article>
    </div>

    <div className="blueprint-create-hint"><span aria-hidden="true">i</span><strong>建议先按推荐方案创建；员工、字段、视图和流程创建后仍可随时调整。</strong></div>

    <details className="details-collapse blueprint-advanced">
      <summary>高级配置与协议</summary>
      <div className="blueprint-advanced-grid">
        <section><strong>Task 输入</strong><p>{draft.taskProtocol.inputFields.join(' · ')}</p></section>
        <section><strong>Task 输出</strong><p>{draft.taskProtocol.outputFields.join(' · ')}</p></section>
        <section><strong>知识关系</strong><p>{draft.knowledgeModel.relationTypes.length} 种关系 · {draft.knowledgeModel.eventTypes.length} 种事件</p></section>
        <section><strong>成果协议</strong><p>{draft.knowledgeModel.artifactTypes.map((artifact) => artifact.label).join(' · ') || '按项目定义'}</p></section>
      </div>
    </details>
  </div>;
}

function viewKindLabel(kind: CompanySetupDraft['knowledgeModel']['views'][number]['kind']): string {
  return ({ list: '列表', cards: '卡片', board: '看板', graph: '关系图', timeline: '时间线', matrix: '矩阵', document: '文档', metrics: '指标' } as const)[kind];
}
