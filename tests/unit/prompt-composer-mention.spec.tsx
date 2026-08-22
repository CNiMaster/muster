/**
 * 批次 H.9：PromptComposer @ 引用（员工/文件/任务三类候选、键盘选择、refs 上送）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptComposer } from '../../src/client/components/workbench/PromptComposer';
import type { Agent } from '../../src/client/api/types';

const AGENTS: Agent[] = [
  { id: 'ag_1', name: '林晚晴', role: 'lead' } as Agent,
  { id: 'ag_2', name: '绘图蜂', role: 'swarm-worker' } as Agent,
];

let sent: Array<{ content: string; refs?: string[] }> = [];

function renderComposer(props: Partial<Parameters<typeof PromptComposer>[0]> = {}): void {
  render(
    <PromptComposer
      agents={AGENTS}
      taskOptions={[{ id: 'pt_3', label: '#3 修复登录' }]}
      fileOptions={[{ path: 'docs/报告.md' }, { path: 'assets/图.png' }]}
      onSend={(content, options) => sent.push({ content, refs: options?.refs })}
      {...props}
    />,
  );
}

describe('PromptComposer @引用（批次 H.9）', () => {
  beforeEach(() => {
    localStorage.clear();
    sent = [];
  });
  afterEach(cleanup);

  it('输入 @ 弹出三类候选；按显示名筛选', () => {
    renderComposer();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '看看 @' } });
    expect(screen.getByText('@林晚晴')).toBeInTheDocument();
    expect(screen.getByText('@#3 修复登录')).toBeInTheDocument();
    expect(screen.getByText('@docs/报告.md')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '看看 @图' } });
    expect(screen.getByText('@assets/图.png')).toBeInTheDocument();
    expect(screen.queryByText('@林晚晴')).not.toBeInTheDocument();
  });

  it('点击候选插入 @名称 尾随空格；发送时 refs 上送类型前缀 token', () => {
    renderComposer();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '基于 @报告' } });
    fireEvent.mouseDown(screen.getByText('@docs/报告.md'));
    expect(input.value).toBe('基于 @docs/报告.md ');
    fireEvent.change(input, { target: { value: input.value + '继续做' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.refs).toEqual(['file:docs/报告.md']);
  });

  it('键盘上下选择 + Enter 插入；Escape 关闭；未匹配的 @文本 不产生 refs', () => {
    renderComposer();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toMatch(/^@.+ /);
    fireEvent.change(input, { target: { value: '别的 @不存在的词' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.change(input, { target: { value: '别的 @不存在的词' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.refs).toBeUndefined();
  });
});
