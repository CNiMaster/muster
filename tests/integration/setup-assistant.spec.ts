import { describe, expect, it } from 'vitest';
import {
  generateAgentProposal,
  generateCompanyProposal,
  generateProjectProposal,
  type SetupGenerator,
} from '../../src/server/domain/setup-assistant';

class StaticGenerator implements SetupGenerator {
  constructor(private value: unknown) {}
  async generate(): Promise<unknown> {
    return this.value;
  }
}

class FailingGenerator implements SetupGenerator {
  async generate(): Promise<unknown> {
    throw new Error('SECRET_DIAGNOSTIC /usr/local/bin/claude --json-schema stderr');
  }
}

describe('setup assistant', () => {
  it('结构化 Claude 结果明确标记 source=claude', async () => {
    const result = await generateAgentProposal(
      { name: '润色员', duty: '统一文风' },
      new StaticGenerator({
        role: 'editor',
        responsibilities: '检查章节语言并保持文风一致',
        skills: ['proofreading'],
        tools: [],
        contactRoles: ['writer'],
      }),
    );
    expect(result.source).toBe('claude');
    expect(result.proposal.role).toBe('editor');
    expect(result.warning).toBeUndefined();
  });

  it('执行器不可用时返回显式离线模板和 warning，不伪造 AI 成功', async () => {
    const company = await generateCompanyProposal(
      { name: '离线公司', goal: '创作长篇小说' },
      new FailingGenerator(),
    );
    const project = await generateProjectProposal(
      { prompt: '凡人修仙成长故事' },
      new FailingGenerator(),
    );

    expect(company.source).toBe('offline_template');
    expect(company.warning).toBe('智能方案暂时不可用，已为你载入可编辑的默认团队配置。');
    expect(company.warning).not.toContain('SECRET_DIAGNOSTIC');
    expect(company.warning).not.toContain('--json-schema');
    expect(company.proposal.charter).toContain('离线公司');
    expect(project.source).toBe('offline_template');
    expect(project.warning).toBe('智能方案暂时不可用，已为你载入可编辑的默认项目蓝图。');
    expect(project.proposal.outline).toBe('凡人修仙成长故事');
  });

  it('无效结构化结果同样降级且说明原因', async () => {
    const result = await generateProjectProposal(
      { prompt: '故事' },
      new StaticGenerator({ name: '' }),
    );
    expect(result.source).toBe('offline_template');
    expect(result.warning).toBe('智能方案暂时不可用，已为你载入可编辑的默认项目蓝图。');
  });
});
