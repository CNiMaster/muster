/**
 * 上下文装配器。
 *
 PRD：每次执行只装载公司章程、项目说明、员工职责、当前 Task 工作包和明确引用的成果。
 不把整份组织/流程定义塞入每次模型上下文。
 */
import type { DB } from '../db/client';
import { getCompany } from '../domain/company';
import { getProject } from '../domain/project';
import { getAgent } from '../domain/agent';
import { getTask } from '../domain/task';
import { listTaskMessages } from '../domain/task-message';
import type { Task } from '../domain/task';

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
  const systemPrompt = sp.join('\n');

  // ===== Input Packet =====
  const recentMessages = listTaskMessages(db, task.id).slice(-6);
  const inputPacket: Record<string, unknown> = {
    ...task.inputProtocol,
    taskId: task.id,
    taskSeq: task.seq,
    title: task.title,
    outputProtocol: task.outputProtocol,
    contextRefs: task.contextRefs,
    recentDiscussion: recentMessages.map((m) => ({ author: m.author, role: m.role, content: m.content })),
  };

  return {
    systemPrompt,
    inputPacket,
    referencedArtifacts: {},
  };
}

void getTask; // 预留：未来用于加载父 Task 上下文
