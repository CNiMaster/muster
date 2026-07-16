import type { DB } from '../db/client';
import { nowIso, shortId } from '../../shared/utils';
import { companyTemplateDraftSchema, type CompanyTemplateDraft } from '../../shared/company-template';
import { createBuiltinCompanyTemplateDraft, listBuiltinCompanyTemplates } from './template-registry';
import { validateCompanyTemplateDraft } from './template-health';

interface TemplateInstallationRow {
  id: string;
  company_id: string;
  template_id: string;
  template_version: number;
  snapshot_json: string;
  overrides_json: string;
  created_at: string;
  updated_at: string;
}

interface CapabilityBindingRow {
  id: string;
  company_id: string;
  employee_id: string | null;
  scope: CapabilityBinding['scope'];
  scope_key: string;
  capability_id: string;
  skill_ids_json: string;
  recommended_tool_ids_json: string;
  requires_executor_kind: string;
  purpose: string;
  load_when: string;
  created_at: string;
  updated_at: string;
}

export interface CompanyTemplateInstallation {
  id: string;
  companyId: string;
  templateId: string;
  templateVersion: number;
  snapshot: CompanyTemplateDraft;
  overrides: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityBinding {
  id: string;
  companyId: string;
  employeeId: string | null;
  scope: 'role' | 'employee' | 'field' | 'task';
  scopeKey: string;
  capabilityId: string;
  skillIds: string[];
  recommendedToolIds: string[];
  requiresExecutorKind: '' | 'cli' | 'api';
  purpose: string;
  loadWhen: string;
  createdAt: string;
  updatedAt: string;
}

function mapInstallation(row: TemplateInstallationRow): CompanyTemplateInstallation {
  return {
    id: row.id,
    companyId: row.company_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    snapshot: companyTemplateDraftSchema.parse(JSON.parse(row.snapshot_json)),
    overrides: JSON.parse(row.overrides_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCapabilityBinding(row: CapabilityBindingRow): CapabilityBinding {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    scope: row.scope,
    scopeKey: row.scope_key,
    capabilityId: row.capability_id,
    skillIds: JSON.parse(row.skill_ids_json) as string[],
    recommendedToolIds: JSON.parse(row.recommended_tool_ids_json) as string[],
    requiresExecutorKind: (row.requires_executor_kind || '') as CapabilityBinding['requiresExecutorKind'],
    purpose: row.purpose,
    loadWhen: row.load_when,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function syncBuiltinTemplateVersions(db: DB): void {
  const now = nowIso();
  const upsertDefinition = db.prepare(`
    INSERT INTO template_definition (id, name, source, current_version, created_at, updated_at)
    VALUES (?, ?, 'builtin', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      current_version=MAX(template_definition.current_version, excluded.current_version),
      updated_at=excluded.updated_at
  `);
  const insertVersion = db.prepare(`
    INSERT OR IGNORE INTO template_version
      (id, template_id, version, manifest_json, validation_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const template of listBuiltinCompanyTemplates()) {
    const draft = createBuiltinCompanyTemplateDraft({
      templateId: template.id,
      name: template.name,
      goal: template.recommendedUse,
    });
    const validation = validateCompanyTemplateDraft(draft);
    upsertDefinition.run(template.id, template.name, template.version, now, now);
    insertVersion.run(
      `${template.id}:${template.version}`,
      template.id,
      template.version,
      JSON.stringify(template),
      JSON.stringify(validation),
      now,
    );
  }
}

export function installCompanyTemplate(db: DB, input: {
  companyId: string;
  draft: CompanyTemplateDraft;
  employeeIdsByRole: ReadonlyMap<string, string>;
}): CompanyTemplateInstallation {
  syncBuiltinTemplateVersions(db);
  const now = nowIso();
  const installationId = shortId('ti_');
  db.prepare(`
    INSERT INTO company_template_installation
      (id, company_id, template_id, template_version, snapshot_json, overrides_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '{}', ?, ?)
  `).run(
    installationId,
    input.companyId,
    input.draft.templateId,
    input.draft.templateVersion,
    JSON.stringify(input.draft),
    now,
    now,
  );

  const insertBinding = db.prepare(`
    INSERT INTO capability_binding
      (id, company_id, employee_id, scope, scope_key, capability_id, skill_ids_json,
       recommended_tool_ids_json, requires_executor_kind, purpose, load_when, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, scope, scope_key, capability_id) DO UPDATE SET
      employee_id=excluded.employee_id,
      skill_ids_json=excluded.skill_ids_json,
      recommended_tool_ids_json=excluded.recommended_tool_ids_json,
      requires_executor_kind=excluded.requires_executor_kind,
      purpose=excluded.purpose,
      load_when=excluded.load_when,
      updated_at=excluded.updated_at
  `);

  for (const binding of input.draft.capabilityBindings) {
    const employeeId = input.employeeIdsByRole.get(binding.roleKey) ?? null;
    insertBinding.run(
      shortId('cb_'), input.companyId, employeeId, 'employee', employeeId ?? `role:${binding.roleKey}`,
      binding.capabilityId, JSON.stringify(binding.skillIds),
      JSON.stringify(binding.recommendedToolIds), binding.requiresExecutorKind,
      binding.purpose, binding.loadWhen, now, now,
    );
  }

  for (const record of input.draft.knowledgeModel.recordTypes) {
    for (const definition of record.fields) {
      const maintenance = definition.maintenance;
      const employeeId = input.employeeIdsByRole.get(maintenance.ownerRoleKey) ?? null;
      for (const capabilityId of maintenance.requiredCapabilityIds) {
        insertBinding.run(
          shortId('cb_'), input.companyId, employeeId, 'field', `${record.key}.${definition.key}`,
          capabilityId, JSON.stringify(maintenance.recommendedSkillIds),
          JSON.stringify([]), '',
          `维护${record.label}·${definition.label}`,
          `${maintenance.updatePolicy}；${maintenance.reviewPolicy}`,
          now, now,
        );
      }
    }
  }

  return getCompanyTemplateInstallation(db, input.companyId);
}

export function getCompanyTemplateInstallation(db: DB, companyId: string): CompanyTemplateInstallation {
  const row = db.prepare('SELECT * FROM company_template_installation WHERE company_id=?').get(companyId) as TemplateInstallationRow | undefined;
  if (!row) throw new Error('公司尚未安装模板快照');
  return mapInstallation(row);
}

export function listCapabilityBindings(db: DB, companyId: string): CapabilityBinding[] {
  const rows = db.prepare('SELECT * FROM capability_binding WHERE company_id=? ORDER BY scope, scope_key, capability_id').all(companyId) as CapabilityBindingRow[];
  return rows.map(mapCapabilityBinding);
}
