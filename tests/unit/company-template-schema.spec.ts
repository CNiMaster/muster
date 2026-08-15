import { describe, expect, it } from 'vitest';
import { companyTemplateDraftSchema } from '../../src/shared/company-template';

function makeBlueprint(): Record<string, unknown> {
  return {
    templateId: 'research-lab',
    templateVersion: 1,
    name: '证据实验室',
    goal: '持续产出可追溯的研究结论',
    summary: {
      positioning: '面向复杂问题的研究工作台',
      deliverables: ['研究报告'],
      operatingModel: '研究员收集证据，负责人审核结论',
    },
    departments: [{ key: 'research', name: '研究部' }],
    employees: [{
      key: 'lead',
      name: '研究负责人',
      role: 'lead',
      responsibilities: '确定问题、审核证据和结论',
      departmentKey: 'research',
      isLead: true,
    }],
    project: { name: '首个研究项目', description: '验证一个关键判断' },
    firstProjectTask: { title: '定义研究问题', brief: '明确范围、证据标准和验收条件' },
    taskProtocol: {
      version: 1,
      inputFields: ['goal', 'references'],
      outputFields: ['summary', 'evidence'],
    },
    relationships: { org: [], communication: [] },
    workflow: {
      nodes: [
        { key: 'start', kind: 'start', label: '开始', position: { x: 0, y: 0 } },
        { key: 'employee:lead', kind: 'step', label: '研究负责人', position: { x: 200, y: 0 } },
        { key: 'end', kind: 'end', label: '完成', position: { x: 400, y: 0 } },
      ],
      edges: [
        { sourceKey: 'start', targetKey: 'employee:lead', label: '接单' },
        { sourceKey: 'employee:lead', targetKey: 'end', label: '提交' },
      ],
    },
    knowledgeModel: {
      recordTypes: [{
        key: 'claim',
        label: '结论',
        description: '需要证据支持的判断',
        fields: [{
          key: 'statement',
          label: '结论内容',
          type: 'text',
          required: true,
          maintenance: {
            ownerRoleKey: 'lead',
            collaboratorRoleKeys: [],
            requiredCapabilityIds: ['evidence-review'],
            recommendedSkillIds: ['research'],
            inputRequirements: ['研究问题', '证据来源'],
            outputRequirements: ['可验证结论'],
            updatePolicy: 'on_demand',
            reviewPolicy: 'lead_review',
          },
        }],
      }],
      relationTypes: [],
      eventTypes: [],
      artifactTypes: [{ key: 'report', label: '研究报告', format: 'markdown', ownerRoleKey: 'lead' }],
      views: [{ key: 'claim-list', label: '结论', kind: 'list', sourceTypeKey: 'claim', fields: ['statement'] }],
    },
    capabilityBindings: [{
      capabilityId: 'evidence-review',
      label: '证据审查',
      roleKey: 'lead',
      skillIds: ['research'],
      purpose: '检查结论是否有充分证据',
      loadWhen: '维护结论字段时',
    }],
    automations: [],
    healthFindings: [],
    presentation: { density: 'guided', mark: '研', colorToken: 'blue' },
    generation: { source: 'builtin_template' },
  };
}

describe('company template schema', () => {
  it('accepts a generic blueprint with field ownership and views', () => {
    const parsed = companyTemplateDraftSchema.parse(makeBlueprint());

    expect(parsed.knowledgeModel.recordTypes[0]!.fields[0]!.maintenance.ownerRoleKey).toBe('lead');
    expect(parsed.knowledgeModel.views[0]!.kind).toBe('list');
  });

  it('rejects executable presentation payloads', () => {
    const input = makeBlueprint();
    input.presentation = { density: 'guided', mark: '研', colorToken: 'blue', html: '<script>alert(1)</script>' };

    expect(() => companyTemplateDraftSchema.parse(input)).toThrow();
  });

  it('rejects unknown top-level fields so model output cannot smuggle runtime configuration', () => {
    expect(() => companyTemplateDraftSchema.parse({ ...makeBlueprint(), shellCommand: 'rm -rf /' })).toThrow();
  });
});
