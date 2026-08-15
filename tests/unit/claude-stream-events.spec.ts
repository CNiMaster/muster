import { describe, it, expect } from 'vitest';
import { parseClaudeStreamEvent } from '../../src/server/executors/claude-stream-events';

describe('claude stream-json 解析', () => {
  it('assistant 事件拆出 text/thinking/tool_use', () => {
    const parts = parseClaudeStreamEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '先看一下目录结构' },
          { type: 'text', text: '开始写代码' },
          { type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: '/tmp/x/a.md', old_string: 'a', new_string: 'b' } },
        ],
      },
    });
    expect(parts.outputs).toEqual(['开始写代码']);
    expect(parts.thinking).toEqual(['先看一下目录结构']);
    expect(parts.toolCalls).toEqual([{ toolUseId: 'tu_1', name: 'Edit', input: { file_path: '/tmp/x/a.md', old_string: 'a', new_string: 'b' } }]);
  });

  it('user 事件拆出 tool_result（字符串与内容数组两种格式）', () => {
    const parts = parseClaudeStreamEvent({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: '已编辑' },
        { type: 'tool_result', tool_use_id: 'tu_2', content: [{ type: 'text', text: '读取到 3 行' }] },
      ] },
    });
    expect(parts.toolResults).toEqual([
      { toolUseId: 'tu_1', content: '已编辑' },
      { toolUseId: 'tu_2', content: '读取到 3 行' },
    ]);
  });

  it('非消息事件返回空', () => {
    expect(parseClaudeStreamEvent({ type: 'result' })).toEqual({ outputs: [], thinking: [], toolCalls: [], toolResults: [] });
  });
});
