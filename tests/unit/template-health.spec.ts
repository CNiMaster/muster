import { describe, expect, it } from 'vitest';
import { createBuiltinCompanyTemplateDraft, getCompanyTemplatePackage, listBuiltinCompanyTemplates } from '../../src/server/domain/template-registry';
import { validateCompanyTemplateDraft } from '../../src/server/domain/template-health';

describe('company template registry', () => {
  it('registers four schema-valid built-in packages with industry knowledge models', () => {
    expect(listBuiltinCompanyTemplates().map((template) => template.id)).toEqual(['general', 'software', 'content', 'novel', 'marketing', 'consulting']);
    expect(getCompanyTemplatePackage('software').knowledgeModel.recordTypes.map((type) => type.key)).toContain('requirement');
    expect(getCompanyTemplatePackage('novel').knowledgeModel.recordTypes.map((type) => type.key)).toContain('character');
  });

  it('materializes an editable draft without sharing package arrays', () => {
    const first = createBuiltinCompanyTemplateDraft({ templateId: 'software', name: 'Acme', goal: '发布产品' });
    first.departments[0]!.name = '已修改';
    const second = createBuiltinCompanyTemplateDraft({ templateId: 'software', name: 'Acme 2', goal: '发布第二个产品' });

    expect(second.departments[0]!.name).not.toBe('已修改');
    expect(second.generation.source).toBe('builtin_template');
  });
});

describe('company template health', () => {
  it('reports a blocking finding when a field owner role does not exist', () => {
    const draft = createBuiltinCompanyTemplateDraft({ templateId: 'software', name: 'Acme', goal: '发布产品' });
    draft.knowledgeModel.recordTypes[0]!.fields[0]!.maintenance.ownerRoleKey = 'missing-owner';

    expect(validateCompanyTemplateDraft(draft)).toContainEqual(expect.objectContaining({
      code: 'field_owner_missing',
      severity: 'blocking',
      path: expect.stringContaining('knowledgeModel.recordTypes.requirement.fields'),
    }));
  });

  it('reports broken view references and unavailable recommended skills', () => {
    const draft = createBuiltinCompanyTemplateDraft({ templateId: 'software', name: 'Acme', goal: '发布产品' });
    draft.knowledgeModel.views[0]!.sourceTypeKey = 'missing-record';

    const findings = validateCompanyTemplateDraft(draft, { installedSkillIds: new Set(['implementation']) });

    expect(findings).toContainEqual(expect.objectContaining({ code: 'view_source_missing', severity: 'blocking' }));
    expect(findings).toContainEqual(expect.objectContaining({ code: 'recommended_skill_missing', severity: 'warning' }));
  });

  it('accepts every built-in draft without blocking findings', () => {
    for (const template of listBuiltinCompanyTemplates()) {
      const draft = createBuiltinCompanyTemplateDraft({ templateId: template.id, name: template.name, goal: template.recommendedUse });
      expect(validateCompanyTemplateDraft(draft).filter((finding) => finding.severity === 'blocking')).toEqual([]);
    }
  });
});
