/**
 * Claude Code stream-json 事件解析（纯函数，供 adapter 与测试使用）。
 * 从 assistant/user 事件中拆出：文本输出、思考块、工具调用、工具结果。
 */
export const CLAUDE_FILE_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit']);

export interface ClaudeStreamEventParts {
  outputs: string[];
  thinking: string[];
  toolCalls: Array<{ toolUseId: string; name: string; input: unknown }>;
  toolResults: Array<{ toolUseId: string; content: string }>;
}

export function parseClaudeStreamEvent(ev: unknown): ClaudeStreamEventParts {
  const parts: ClaudeStreamEventParts = { outputs: [], thinking: [], toolCalls: [], toolResults: [] };
  if (typeof ev !== 'object' || ev === null) return parts;
  const e = ev as { type?: string; message?: { content?: unknown } };
  const content = e.message?.content;
  if (!Array.isArray(content)) return parts;
  for (const block of content as Array<Record<string, unknown>>) {
    if (e.type === 'assistant') {
      if (block.type === 'text' && typeof block.text === 'string') parts.outputs.push(block.text);
      if (block.type === 'thinking' && typeof block.thinking === 'string') parts.thinking.push(block.thinking);
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        parts.toolCalls.push({ toolUseId: block.id, name: block.name, input: block.input });
      }
    }
    if (e.type === 'user' && block.type === 'tool_result') {
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      const c = block.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((p: unknown) => {
              if (typeof p === 'string') return p;
              const obj = p as Record<string, unknown>;
              return obj?.type === 'text' ? String(obj.text ?? '') : '';
            }).join('\n')
          : '';
      parts.toolResults.push({ toolUseId: id, content: text });
    }
  }
  return parts;
}
