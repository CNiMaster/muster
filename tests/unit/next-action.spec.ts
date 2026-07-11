import { describe, expect, it } from 'vitest';
import { deriveNextAction } from '../../src/client/domain/next-action';

const company = { id: 'co_1', name: '示例公司' };
const project = { id: 'pr_1', companyId: 'co_1', name: '示例项目' };

describe('deriveNextAction', () => {
  it('没有公司时引导创建公司', () => {
    expect(deriveNextAction({ companies: [], projects: [], attentionCount: 0 })).toMatchObject({
      kind: 'create-company',
      href: '/companies/wizard',
    });
  });

  it('有公司但没有项目时引导创建项目', () => {
    expect(deriveNextAction({ companies: [company], projects: [], attentionCount: 0 })).toMatchObject({
      kind: 'create-project',
      href: '/companies/co_1/projects/new?onboarding=1',
    });
  });

  it('项目有待确认事项时优先处理', () => {
    expect(deriveNextAction({ companies: [company], projects: [project], attentionCount: 2 })).toMatchObject({
      kind: 'handle-attention',
      href: '/projects/pr_1/tasks',
    });
  });

  it('项目正常时引导发布任务', () => {
    expect(deriveNextAction({ companies: [company], projects: [project], attentionCount: 0 })).toMatchObject({
      kind: 'publish-task',
      href: '/projects/pr_1/tasks',
    });
  });
});
