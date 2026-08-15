import { describe, expect, it } from 'vitest';
import { deriveNextAction } from '../../src/client/domain/next-action';

const company = { id: 'co_1', name: '示例工作台' };
const project = { id: 'pr_1', companyId: 'co_1', name: '示例项目' };

describe('deriveNextAction', () => {
  it('没有工作台时引导创建工作台', () => {
    expect(deriveNextAction({ companies: [], projects: [], attentionCount: 0 })).toMatchObject({
      kind: 'create-company',
      href: '/companies/wizard',
    });
  });

  it('有工作台但没有项目时引导创建项目', () => {
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

  it('项目正常时引导创建项目任务', () => {
    expect(deriveNextAction({ companies: [{ ...company, state: 'online' }], projects: [project], attentionCount: 0 })).toMatchObject({
      kind: 'create-project-task',
      href: '/projects/pr_1#project-tasks',
    });
  });

  it('按运行配置、工作台状态和项目上下文排序行动', () => {
    expect(deriveNextAction({ companies: [{ ...company, state: 'off' }], projects: [project], attentionCount: 0, blockedEmployeeCount: 2 })).toMatchObject({ kind: 'fix-runtime' });
    expect(deriveNextAction({ companies: [{ ...company, state: 'off' }], projects: [project], attentionCount: 0 })).toMatchObject({ kind: 'start-company' });
    expect(deriveNextAction({ companies: [{ ...company, state: 'online' }], projects: [project], attentionCount: 0, activeProjectTaskCount: 1, projectTaskId: 'pt_1' })).toMatchObject({ kind: 'continue-project-task', href: '/projects/pr_1?projectTask=pt_1#project-tasks' });
  });
});
