import { describe, expect, it } from 'vitest';
import type { SetupGenerator } from '../../src/server/domain/setup-assistant';
import { generateCompanyTemplateDraft } from '../../src/server/domain/template-architect';
import { createBuiltinCompanyTemplateDraft } from '../../src/server/domain/template-registry';

class SequenceGenerator implements SetupGenerator {
  calls: Array<{ prompt: string; jsonSchema: Record<string, unknown> }> = [];

  constructor(private values: unknown[]) {}

  async generate(input: { prompt: string; jsonSchema: Record<string, unknown> }): Promise<unknown> {
    this.calls.push(input);
    return this.values[Math.min(this.calls.length - 1, this.values.length - 1)];
  }
}

class FailingGenerator implements SetupGenerator {
  calls = 0;

  async generate(): Promise<unknown> {
    this.calls += 1;
    throw new Error('SECRET /usr/local/bin/claude --json-schema stderr');
  }
}

function generatedSoftwareDraft(): ReturnType<typeof createBuiltinCompanyTemplateDraft> {
  const draft = createBuiltinCompanyTemplateDraft({ templateId: 'software', name: 'Acme', goal: '发布协作软件' });
  draft.summary.positioning = '面向小团队的协作软件公司';
  return draft;
}

describe('template architect', () => {
  it('accepts a schema-valid generic company blueprint and marks its source', async () => {
    const generator = new SequenceGenerator([generatedSoftwareDraft()]);

    const result = await generateCompanyTemplateDraft(
      { templateId: 'software', name: 'Acme', goal: '发布协作软件' },
      generator,
    );

    expect(result.source).toBe('template_architect');
    expect(result.proposal.generation.source).toBe('template_architect');
    expect(result.proposal.summary.positioning).toBe('面向小团队的协作软件公司');
    expect(result.proposal.knowledgeModel.recordTypes.map((record) => record.key)).toContain('requirement');
    expect(generator.calls[0]!.jsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('repairs one invalid structured result before falling back', async () => {
    const generator = new SequenceGenerator([{ name: '' }, generatedSoftwareDraft()]);

    const result = await generateCompanyTemplateDraft(
      { templateId: 'software', name: 'Acme', goal: '发布协作软件' },
      generator,
    );

    expect(result.source).toBe('template_architect');
    expect(generator.calls).toHaveLength(2);
    expect(generator.calls[1]!.prompt).toContain('修复');
  });

  it('uses the selected built-in template after two invalid structured results', async () => {
    const generator = new SequenceGenerator([{ name: '' }, { templateId: 'software', employees: [] }]);

    const result = await generateCompanyTemplateDraft(
      { templateId: 'software', name: 'Acme', goal: '发布协作软件' },
      generator,
    );

    expect(result.source).toBe('builtin_template');
    expect(result.warning).toBe('智能方案暂时不可用，已为你载入可编辑的推荐公司蓝图。');
    expect(result.proposal.generation.warning).toBe(result.warning);
    expect(result.proposal.templateId).toBe('software');
    expect(generator.calls).toHaveLength(2);
  });

  it('falls back immediately when the model executor is unavailable and hides diagnostics', async () => {
    const generator = new FailingGenerator();

    const result = await generateCompanyTemplateDraft(
      { templateId: 'general', name: '离线公司', goal: '完成研究交付' },
      generator,
    );

    expect(result.source).toBe('builtin_template');
    expect(result.warning).not.toContain('SECRET');
    expect(result.warning).not.toContain('--json-schema');
    expect(generator.calls).toBe(1);
  });

  it('never accepts model-provided HTML', async () => {
    const unsafe = generatedSoftwareDraft() as unknown as Record<string, unknown>;
    unsafe.presentation = { density: 'guided', mark: '码', colorToken: 'orange', html: '<script>alert(1)</script>' };
    const generator = new SequenceGenerator([unsafe, unsafe]);

    const result = await generateCompanyTemplateDraft(
      { templateId: 'software', name: 'Acme', goal: '发布协作软件' },
      generator,
    );

    expect(result.source).toBe('builtin_template');
    expect(result.proposal.presentation).not.toHaveProperty('html');
  });
});
