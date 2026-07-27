/**
 * 团队市场：选择一套角色包，批量入职到指定公司。
 * 与旧"添加整套"的区别：不再只建全局档案，而是真正入职到选定公司。
 */
import type React from 'react';
import { useState } from 'react';
import { EMPLOYEE_TEMPLATE_PACKS, ROLE_TEMPLATES } from '../../../shared/role-templates';
import { Button, toast } from '../Button';
import { Card } from '../Card';
import { Field, Select } from '../Form';
import { Badge } from '../Badge';
import { useCompanies, useRecruitFromDraft } from '../../hooks/queries';
import type { RecruitmentDraft } from '../../../shared/role-templates';

export function TeamPackPicker(): React.ReactElement {
  const { data: companies = [] } = useCompanies();
  const activeCompanies = companies.filter((c) => !c.archivedAt);
  const recruit = useRecruitFromDraft();
  const [companyId, setCompanyId] = useState('');
  const [busyPack, setBusyPack] = useState<string | null>(null);

  const addPackToCompany = async (packId: 'general' | 'software' | 'content' | 'novel'): Promise<void> => {
    if (!companyId) {
      toast('error', '请先选择目标公司');
      return;
    }
    const company = activeCompanies.find((c) => c.id === companyId);
    if (!company) {
      toast('error', '公司不存在或已归档');
      return;
    }
    if (company.state !== 'off') {
      toast('error', '请先让公司下班再加入团队');
      return;
    }
    const pack = EMPLOYEE_TEMPLATE_PACKS.find((item) => item.id === packId);
    if (!pack) return;
    setBusyPack(pack.id);
    try {
      let ok = 0;
      let fail = 0;
      for (const role of pack.roles) {
        const template = ROLE_TEMPLATES.find((item) => item.id === role.templateId);
        if (!template) { fail++; continue; }
        const draft: RecruitmentDraft = {
          source: 'role-template',
          displayName: role.displayName,
          role: template.role,
          responsibilities: template.responsibilities,
          capabilities: { skills: template.skills, tools: template.tools },
          departmentId: null,
          executorProfileId: null,
          permissionPolicyId: null,
        };
        try {
          await recruit.mutateAsync({ companyId, draft });
          ok++;
        } catch {
          fail++;
        }
      }
      toast(ok ? 'success' : 'error', ok ? `已入职 ${ok} 位员工到「${company.name}」${fail ? `（${fail} 位失败）` : ''}` : '入职失败，请检查执行器/权限是否已配置');
    } finally {
      setBusyPack(null);
    }
  };

  return (
    <Card title="团队市场" actions={<Badge tone="info">整套入职</Badge>}>
      <div className="form-stack">
        <p className="muted">选择一套匹配的团队，批量入职到指定公司。员工入职后可在该公司「组织架构」里单独配置执行器与权限。</p>
        <Field label="目标公司" required>
          <Select value={companyId} onChange={(e) => setCompanyId((e.target as HTMLSelectElement).value)}>
            <option value="">请选择公司</option>
            {activeCompanies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}（{c.kind}）</option>
            ))}
          </Select>
        </Field>
        <div className="employee-pack-grid">
          {EMPLOYEE_TEMPLATE_PACKS.map((pack) => {
            const templates = pack.roles.map((role) => ({
              ...ROLE_TEMPLATES.find((item) => item.id === role.templateId)!,
              name: role.displayName,
            }));
            return (
              <article key={pack.id} className={`employee-pack-card is-${pack.id}`}>
                <div className="employee-pack-head">
                  <span className="employee-pack-mark" aria-hidden="true">{pack.mark}</span>
                  <div>
                    <h3>{pack.name}</h3>
                    <p>{pack.description}</p>
                  </div>
                </div>
                <div className="employee-pack-roles">
                  {templates.map((item) => <span key={item.id}>{item.name}</span>)}
                </div>
                <Button
                  size="sm"
                  disabled={!companyId || busyPack !== null}
                  loading={busyPack === pack.id}
                  onClick={() => void addPackToCompany(pack.id)}
                >
                  入职到公司
                </Button>
              </article>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
