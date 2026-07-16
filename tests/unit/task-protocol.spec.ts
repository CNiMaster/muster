import { describe, expect, it } from 'vitest';
import { buildTaskInputProtocol, getTaskProtocolRows } from '../../src/client/domain/task-protocol';

describe('task handoff protocol', () => {
  it('normalizes a structured work order and drops empty reference lines', () => {
    expect(buildTaskInputProtocol({
      goal: '  完成登录页重构  ',
      background: '  当前移动端不可用 ',
      references: 'PRD.md\n\n figma://login  ',
      acceptance: '  390px 下无横向滚动 ',
      deliverables: '  代码、测试和说明 ',
    })).toEqual({
      goal: '完成登录页重构',
      background: '当前移动端不可用',
      references: ['PRD.md', 'figma://login'],
      acceptance: '390px 下无横向滚动',
      deliverables: '代码、测试和说明',
    });
  });

  it('returns readable rows while ignoring protocol metadata', () => {
    expect(getTaskProtocolRows({
      requiredFields: ['goal', 'acceptance'],
      goal: '完成登录页重构',
      references: ['PRD.md', '截图.png'],
      acceptance: '测试通过',
    })).toEqual([
      { key: 'goal', label: '工作目标', value: '完成登录页重构' },
      { key: 'references', label: '参考资料', value: 'PRD.md\n截图.png' },
      { key: 'acceptance', label: '验收标准', value: '测试通过' },
    ]);
  });
});
