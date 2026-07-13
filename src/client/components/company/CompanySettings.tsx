import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Company } from '../../api/types';
import { useUpdateCompany } from '../../hooks/queries';
import { Button, toast } from '../Button';
import { Card } from '../Card';

const INPUT_FIELDS = [
  { key: 'goal', label: '目标' },
  { key: 'context', label: '背景' },
  { key: 'references', label: '引用资料' },
  { key: 'acceptance', label: '验收标准' },
];
const OUTPUT_FIELDS = [
  { key: 'summary', label: '结论摘要' },
  { key: 'artifacts', label: '成果文件' },
  { key: 'risks', label: '风险与阻塞' },
  { key: 'nextSteps', label: '下一步' },
];

export function CompanySettings({ company }: { company: Company }): React.ReactElement {
  const updateCompany = useUpdateCompany();
  const savedProtocol = (company.contractJson.taskProtocol ?? {}) as { inputFields?: string[]; outputFields?: string[] };
  const [inputFields, setInputFields] = useState(savedProtocol.inputFields ?? INPUT_FIELDS.map((item) => item.key));
  const [outputFields, setOutputFields] = useState(savedProtocol.outputFields ?? OUTPUT_FIELDS.map((item) => item.key));
  const toggle = (values: string[], key: string, setValues: (next: string[]) => void): void => setValues(values.includes(key) ? values.filter((value) => value !== key) : [...values, key]);
  const saveProtocol = (): void => {
    updateCompany.mutate({
      id: company.id,
      contractJson: { ...company.contractJson, taskProtocol: { inputFields, outputFields } },
    }, {
      onSuccess: () => toast('success', '任务交接格式已保存'),
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  return <div className="form-stack company-settings-surface">
    <Card id="collaboration-rules" title="组织与协作规则">
      <div className="collaboration-rule-grid">
        <Link to={`/companies/${company.id}/graphs/org`}><span aria-hidden="true">组</span><strong>上下级关系</strong><small>谁负责谁、向谁上报</small></Link>
        <Link to={`/companies/${company.id}/graphs/communication`}><span aria-hidden="true">联</span><strong>员工引用关系</strong><small>谁可以找谁协作</small></Link>
        <Link to={`/companies/${company.id}/workflows/main`}><span aria-hidden="true">流</span><strong>公司工作流</strong><small>何时转交给下一岗位</small></Link>
        <Link to={`/companies/${company.id}?view=team`}><span aria-hidden="true">岗</span><strong>岗位职责</strong><small>能力、权限与任职配置</small></Link>
      </div>
    </Card>

    <Card title="任务交接格式" actions={<Button size="sm" onClick={saveProtocol} loading={updateCompany.isPending}>保存</Button>}>
      <div className="task-protocol-builder">
        <fieldset><legend>派发工作时应包含</legend><div>{INPUT_FIELDS.map((field) => <label key={field.key} className={inputFields.includes(field.key) ? 'is-selected' : ''}><input type="checkbox" checked={inputFields.includes(field.key)} onChange={() => toggle(inputFields, field.key, setInputFields)} /><span>{field.label}</span></label>)}</div></fieldset>
        <span className="protocol-arrow" aria-hidden="true">→</span>
        <fieldset><legend>员工完成时应返回</legend><div>{OUTPUT_FIELDS.map((field) => <label key={field.key} className={outputFields.includes(field.key) ? 'is-selected' : ''}><input type="checkbox" checked={outputFields.includes(field.key)} onChange={() => toggle(outputFields, field.key, setOutputFields)} /><span>{field.label}</span></label>)}</div></fieldset>
      </div>
    </Card>

    <Card title="公司章程">
      {company.charter ? <pre className="charter">{company.charter}</pre> : <p className="muted">尚未设置公司章程。</p>}
    </Card>
    <Card title="执行环境">
      <div className="settings-link-row"><Link className="mu-btn mu-btn-subtle" to="/executors">执行器中心</Link><Link className="mu-btn mu-btn-subtle" to="/permissions">权限中心</Link></div>
    </Card>
  </div>;
}
