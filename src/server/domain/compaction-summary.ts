/**
 * 会话压缩自动摘要（批次 C，economy 档 LLM）。
 *
 * 聚合 Thread 的最近任务 summary、handoff 与近期讨论，
 * 调用 economy 档 LLM 提炼 ≤400 字中文摘要。
 * 失败/超时降级为固定兜底文案，绝不阻断压缩与会话流转。
 */
import type { DB } from '../db/client';
import { callLlm } from './llm-call';
import { log } from '../logger';

export const DEFAULT_COMPACTION_SUMMARY = (dateStr = new Date().toISOString().slice(0, 10)) =>
  `[自动压缩 ${dateStr}] 过往执行记录已归档，上下文已延续。`;

interface TaskRow {
  title: string;
  summary: string | null;
}

interface MessageRow {
  sender?: string;
  role?: string;
  content: string;
}

export async function generateCompactionSummary(db: DB, threadId: string): Promise<string> {
  const dateStr = new Date().toISOString().slice(0, 10);
  const fallback = DEFAULT_COMPACTION_SUMMARY(dateStr);

  try {
    const contextLines: string[] = [];

    // 1. 尝试从 project_agent_thread 收集信息
    const pat = db.prepare(
      'SELECT id, project_id, agent_id, compaction_summary FROM project_agent_thread WHERE id=?',
    ).get(threadId) as { id: string; project_id: string; agent_id: string; compaction_summary: string | null } | undefined;

    if (pat) {
      if (pat.compaction_summary) {
        contextLines.push(`【上一轮摘要】\n${pat.compaction_summary}`);
      }
      const tasks = db.prepare(
        "SELECT title, summary FROM task WHERE project_id=? AND assignee_agent_id=? AND state='completed' AND summary IS NOT NULL ORDER BY updated_at DESC LIMIT 5",
      ).all(pat.project_id, pat.agent_id) as TaskRow[];

      if (tasks.length > 0) {
        contextLines.push('【已完成任务】\n' + tasks.map((t) => `- ${t.title}：${t.summary}`).join('\n'));
      }

      const msgs = db.prepare(
        "SELECT role, content FROM conversation_message WHERE scope_kind='project' AND scope_id=? ORDER BY created_at DESC LIMIT 5",
      ).all(pat.project_id) as MessageRow[];

      if (msgs.length > 0) {
        contextLines.push('【近期讨论】\n' + msgs.map((m) => `- ${m.role ?? '用户'}：${m.content.slice(0, 100)}`).join('\n'));
      }
    }

    // 2. 尝试从 project_task_thread 收集信息
    const ptt = db.prepare(
      'SELECT id, project_task_id, employee_id, handoff_json FROM project_task_thread WHERE id=?',
    ).get(threadId) as { id: string; project_task_id: string; employee_id: string; handoff_json: string | null } | undefined;

    if (ptt) {
      if (ptt.handoff_json) {
        try {
          const handoff = JSON.parse(ptt.handoff_json) as Record<string, unknown>;
          if (handoff.lastSummary && typeof handoff.lastSummary === 'string') {
            contextLines.push(`【交接摘要】\n${handoff.lastSummary}`);
          }
        } catch { /* 忽略格式错误 */ }
      }

      const tasks = db.prepare(
        "SELECT title, summary FROM task WHERE project_task_id=? AND state='completed' AND summary IS NOT NULL ORDER BY updated_at DESC LIMIT 5",
      ).all(ptt.project_task_id) as TaskRow[];

      if (tasks.length > 0 && !pat) {
        contextLines.push('【已完成任务】\n' + tasks.map((t) => `- ${t.title}：${t.summary}`).join('\n'));
      }
    }

    if (contextLines.length === 0) {
      return fallback;
    }

    const system = '你是一个精炼的技术上下文提炼专家。你的职责是将过往任务执行记录、工作交接与近期讨论精炼为一段紧凑的会话延续摘要（不超过 400 字）。请保留核心事实、已交付成果、关键技术结论与遗留状态，去除冗余套话。直接输出摘要正文，不要输出多余格式。';
    const user = `请根据以下执行上下文生成紧凑的会话摘要（≤400字中文）：\n\n${contextLines.join('\n\n')}`;

    const res = await callLlm(db, {
      system,
      user,
      tier: 'economy',
      timeoutMs: 30_000,
    });

    const content = res.content.trim();
    if (!content) {
      return fallback;
    }
    return content.slice(0, 500);
  } catch (error) {
    log.warn('generateCompactionSummary failed; falling back to default text', {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}
