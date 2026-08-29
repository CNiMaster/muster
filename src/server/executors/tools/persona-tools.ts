/**
 * 人设手册 builtin 工具（批次 E2 专家知识库工程）。
 *
 * 渐进披露：API 型执行器按节名读取当前任务穿戴人设的专业手册正文（领域方法论/
 * 工作流程/常见陷阱/时效知识）。CLI 型执行器不走本工具——context 注入手册目录 +
 * 文件绝对路径，用自带文件工具直读（同 reference-skill 先例）。
 * 归属规则：按 ctx.taskId 反查 task.persona_id，无人设时明确告知而非报错。
 * 权限：permissionAction='read-file'（只读，同 search_knowledge）。
 */
import type { ToolCall, ToolDefinition, ToolResult } from './file-tools';
import type { ToolContext } from './registry';

export const PERSONA_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_persona_manual',
      description:
        '读取你当前扮演的专家人设的专业手册章节（领域方法论/工作流程/常见陷阱等）。用系统提示「你的专业手册」目录里的节名调用；一次读一节，开工前先读与本任务相关的章节。',
      parameters: {
        type: 'object',
        properties: {
          section: { type: 'string', description: '手册目录中的节名（如「领域专业知识」）' },
        },
        required: ['section'],
        additionalProperties: false,
      },
    },
  },
];

export async function readPersonaManualHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const section = String(call.args.section ?? '').trim();
  if (!section) return { toolCallId: call.id, name: call.name, content: '错误：section 不能为空' };
  try {
    const { getDb } = await import('../../db/client');
    const { getPersona, readPersonaManualSection } = await import('../../domain/persona-library');
    const db = getDb();
    const taskId = ctx.taskId ?? ctx.loopback?.taskId ?? null;
    if (!taskId) return { toolCallId: call.id, name: call.name, content: '错误：无任务上下文，读不到当前人设' };
    const row = db.prepare('SELECT persona_id FROM task WHERE id=?').get(taskId) as
      | { persona_id: string | null }
      | undefined;
    const persona = row?.persona_id ? getPersona(row.persona_id) : null;
    if (!persona) return { toolCallId: call.id, name: call.name, content: '当前任务没有穿戴人设，无人设手册可读。' };
    const content = readPersonaManualSection(persona, section);
    if (content === null) {
      const catalog = persona.sections.map((s) => s.title).join('、');
      return { toolCallId: call.id, name: call.name, content: `手册中没有「${section}」这一节。可用节名：${catalog}` };
    }
    return { toolCallId: call.id, name: call.name, content };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `人设手册读取失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
