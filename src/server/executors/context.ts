/**
 * 上下文装配器。
 *
 PRD：每次执行只装载公司章程、项目说明、员工职责、当前 Task 工作包和明确引用的成果。
 不把整份组织/流程定义塞入每次模型上下文。
 */
import type { DB } from '../db/client';
import { getCompany } from '../domain/company';
import { getProject } from '../domain/project';
import { getAgent, listAgents } from '../domain/agent';
import { listTaskMessages } from '../domain/task-message';
import type { Task } from '../domain/task';
import { getTask as loadTask } from '../domain/task';
import { getArtifactByPath } from '../domain/artifact';
import { readArtifactContent } from '../domain/artifact-content';
import { assertCanReadSource, listProjectReferences } from '../domain/project';

const MAX_REFERENCE_BYTES = 64 * 1024;
const MAX_TOTAL_REFERENCE_BYTES = 256 * 1024;

export interface AssembledContext {
  systemPrompt: string;
  inputPacket: Record<string, unknown>;
  /** 上下文里明确引用的成果内容（path → content）。Phase 4 接入文件读取。 */
  referencedArtifacts: Record<string, string>;
}

export function assembleContext(
  db: DB,
  task: Task,
  options: { threadId?: string; sessionIdHint?: string; referencedArtifactPaths?: string[] } = {},
): AssembledContext {
  const project = getProject(db, task.projectId);
  const company = getCompany(db, project.companyId);
  const agent = task.assigneeAgentId ? getAgent(db, task.assigneeAgentId) : null;

  // ===== System Prompt =====
  const sp: string[] = [];
  if (company.charter) {
    sp.push('# 公司章程', company.charter, '');
  }
  sp.push('# 项目说明', project.description || project.name, '');
  if (agent) {
    sp.push('# 你的职责', `岗位：${agent.role}`, agent.responsibilities || '', '');
    if (agent.skills.length > 0) sp.push('# 指定技能', agent.skills.join('、'), '');
    if (agent.tools.length > 0) sp.push('# 可用能力声明', agent.tools.join('、'), '');
    if (agent.systemPrompt) sp.push(agent.systemPrompt);
  }
  sp.push(
    '# 输出契约',
    '你必须返回 JSON，符合 AgentRunResult 结构：',
    '{ outcome, summary, question?, outboundTasks[], artifacts[], checkpoint? }',
    'outcome ∈ completed | waiting_input | waiting_dependency | blocked',
    '信息不足时用 waiting_input + question 在原 Task 中追问，不要编造。',
    '',
  );
  // 会话压缩摘要（PRD Phase 3.6）：thread 经过压缩后保留的过往会话要点。
  if (options.threadId) {
    const compaction = db
      .prepare('SELECT compaction_summary FROM project_agent_thread WHERE id=?')
      .get(options.threadId) as { compaction_summary: string | null } | undefined;
    if (compaction?.compaction_summary) {
      sp.push('# 过往会话摘要（已压缩）', compaction.compaction_summary, '');
    }
  }
  const systemPrompt = sp.join('\n');

  // ===== Input Packet =====
  const recentMessages = listTaskMessages(db, task.id).slice(-6);
  const referencedArtifacts = loadReferencedArtifacts(db, task);
  const companyAgents = listAgents(db, company.id);
  const availableContacts = agent
    ? agent.contactAllow.flatMap((contactId) => {
        const contact = companyAgents.find((candidate) => candidate.id === contactId);
        return contact
          ? [{ id: contact.id, name: contact.name, role: contact.role, responsibilities: contact.responsibilities }]
          : [];
      })
    : [];
  const inputPacket: Record<string, unknown> = {
    ...task.inputProtocol,
    taskId: task.id,
    taskSeq: task.seq,
    title: task.title,
    outputProtocol: task.outputProtocol,
    contextRefs: task.contextRefs,
    recentDiscussion: recentMessages.map((m) => ({ author: m.author, role: m.role, content: m.content })),
    referencedArtifacts,
    availableContacts,
  };
  if (task.parentTaskId) {
    const parent = loadTask(db, task.parentTaskId);
    inputPacket.parentTask = { id: parent.id, seq: parent.seq, title: parent.title, summary: parent.summary };
  }

  return {
    systemPrompt,
    inputPacket,
    referencedArtifacts,
  };
}

function loadReferencedArtifacts(db: DB, task: Task): Record<string, string> {
  const loaded: Record<string, string> = {};
  let totalBytes = 0;
  for (const ref of task.contextRefs) {
    let projectId = task.projectId;
    let relPath = ref;
    const cross = /^project:([^:]+):(.+)$/.exec(ref);
    if (cross) {
      projectId = cross[1]!;
      relPath = cross[2]!;
      assertCanReadSource(db, task.projectId, projectId);
      const grant = listProjectReferences(db, task.projectId).find((item) => item.sourceProjectId === projectId);
      const root = grant?.sourcePath.replace(/\/+$/, '') ?? '';
      if (root && relPath !== root && !relPath.startsWith(`${root}/`)) {
        throw new Error(`跨项目引用 ${relPath} 超出授权路径 ${root}`);
      }
    }
    if (!getArtifactByPath(db, projectId, relPath)) {
      throw new Error(`上下文成果未登记：${ref}`);
    }
    const content = readArtifactContent(db, projectId, relPath);
    const remaining = MAX_TOTAL_REFERENCE_BYTES - totalBytes;
    if (remaining <= 0) break;
    const limit = Math.min(MAX_REFERENCE_BYTES, remaining);
    const buffer = Buffer.from(content, 'utf8');
    const selected = buffer.subarray(0, limit).toString('utf8');
    loaded[ref] = selected + (buffer.length > limit ? '\n[内容已截断]' : '');
    totalBytes += Buffer.byteLength(selected);
  }
  return loaded;
}
