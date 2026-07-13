import type React from 'react';
import { Link } from 'react-router-dom';
import type { Company } from '../../api/types';
import { Card } from '../Card';

export function CompanySettings({ company }: { company: Company }): React.ReactElement {
  return <div className="form-stack">
    <Card title="公司章程">
      {company.charter ? <pre className="charter">{company.charter}</pre> : <p className="muted">尚未设置公司章程。</p>}
    </Card>
    <Card title="运行默认值">
      <p className="muted">执行器与权限是员工任职配置；公司默认值用于新员工，不会静默修改现有员工。</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Link className="mu-btn mu-btn-subtle" to="/executors">执行器中心</Link>
        <Link className="mu-btn mu-btn-subtle" to="/permissions">权限中心</Link>
        <Link className="mu-btn mu-btn-subtle" to={`/companies/${company.id}/workflows/main`}>工作流设置</Link>
      </div>
    </Card>
  </div>;
}
