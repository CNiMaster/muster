/**
 * 知识库 builtin 工具（capability parity 批次 C2，spec 2026-08-25-agent-host-parity-batches）。
 *
 * 定位：让 API 型执行器能检索知识库（用户喂的文档资料——是什么），与记忆系统
 * （经验教训——怎么做事）分野。检索=词法（expandMatchTokens+FTS5）；口语模糊查询
 * 由模型两步完成：先把口语改写成关键词组合再调本工具。
 *
 * 归属规则（拍板）：默认搜 当前项目库+平台通用库（按 task 反查 projectId）；
 * 无任务上下文时只搜平台库。db 经 getDb() 单例（测试 setDbForTest 可注入）。
 * 权限：permissionAction='read-file'（检索只读，同 search_files）。
 */
import type { ToolCall, ToolDefinition, ToolResult } from './file-tools';
import type { ToolContext } from './registry';

export const KNOWLEDGE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description:
        '检索知识库（用户导入的文档资料：设计文档/手册/规范等）。返回标题+片段+标签。查询请用关键词组合而非口语（如「鉴权 session 流程」而非「登录那块怎么设计的」）。默认搜当前项目库+通用库。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词组合（空格分词，支持中文）' },
          limit: { type: 'integer', description: '返回条数上限，默认 8', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
];

/** 解析当前任务的项目库 id 列表（项目库+平台库）；无任务上下文只剩平台库。 */
export async function resolveKnowledgeBaseIds(ctx: ToolContext): Promise<{ baseIds: string[]; scopeNote: string }> {
  const { getDb } = await import('../../db/client');
  const { ensurePlatformBase } = await import('../../domain/knowledge');
  const db = getDb();
  const platform = ensurePlatformBase(db);
  const taskId = ctx.taskId ?? ctx.loopback?.taskId ?? null;
  if (!taskId) {
    return { baseIds: [platform.id], scopeNote: '无任务上下文，仅搜通用知识库' };
  }
  const row = db.prepare('SELECT project_id FROM task WHERE id=?').get(taskId) as { project_id: string | null } | undefined;
  if (!row?.project_id) return { baseIds: [platform.id], scopeNote: '任务无项目归属，仅搜通用知识库' };
  const { ensureProjectBase } = await import('../../domain/knowledge');
  const projectBase = ensureProjectBase(db, row.project_id);
  return { baseIds: [projectBase.id, platform.id], scopeNote: '项目库+通用库' };
}

export async function searchKnowledgeHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const query = String(call.args.query ?? '').trim();
  if (!query) return { toolCallId: call.id, name: call.name, content: '错误：query 不能为空' };
  const limit = call.args.limit === undefined ? undefined : Number(call.args.limit);
  try {
    const { getDb } = await import('../../db/client');
    const { searchKnowledge } = await import('../../domain/knowledge');
    const { baseIds, scopeNote } = await resolveKnowledgeBaseIds(ctx);
    const hits = searchKnowledge(getDb(), { query, baseIds, limit });
    if (hits.length === 0) {
      return { toolCallId: call.id, name: call.name, content: `知识库未命中（${scopeNote}）。可建议用户把相关资料导入知识库。` };
    }
    const lines = hits.map((h, i) => {
      const tagNote = h.tags.length > 0 ? ` [${h.tags.join(',')}]` : '';
      return `${i + 1}. ${h.title}${tagNote}（${h.charCount} 字）\n   ${h.snippet}`;
    });
    return { toolCallId: call.id, name: call.name, content: `知识库命中 ${hits.length} 条（${scopeNote}）：\n${lines.join('\n')}\n\n需要全文可用知识库页查看（docId 可报给用户）。` };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `知识库检索失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
