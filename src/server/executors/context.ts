/**
 * 上下文装配器。
 *
 PRD：每次执行只装载公司章程、项目说明、员工职责、当前 Task 工作包和明确引用的成果。
 不把整份组织/流程定义塞入每次模型上下文。
 */
import type { DB } from '../db/client';
import type { ResolvedTaskSkill } from '../../shared/types';
import { getCompany } from '../domain/company';
import { getProject } from '../domain/project';
import { getAgent, listAgents } from '../domain/agent';
import { getDispatcherAgentId, DISPATCHER_ROLE } from '../domain/system-agents';
import { listTaskMessages } from '../domain/task-message';
import type { Task } from '../domain/task';
import { getTask as loadTask } from '../domain/task';
import { getArtifactByPath } from '../domain/artifact';
import { readArtifactContent } from '../domain/artifact-content';
import { assertCanReadSource, listProjectReferences } from '../domain/project';
import { buildBridgePromptSection } from '../bridge';
import { getWorkflow, type EdgeCondition } from '../domain/workflow';
import { getAgentProfile } from '../domain/agent-profile';
import { loadContextMemories } from '../domain/memory';
import { resolveTaskSkills } from '../domain/capability-binding';
import { resolveToolRecommendations, buildCapabilityCenterSection } from '../domain/tool-recommendation';
import { listMaterials } from '../domain/material';

const MAX_REFERENCE_BYTES = 64 * 1024;
const MAX_TOTAL_REFERENCE_BYTES = 256 * 1024;

/**
 * 需要 CLI（命令执行能力）的 skill（设计一-3）。
 * 这些 skill 正文依赖跑测试/构建/git/部署等命令，API 型执行器无法真正执行。
 * 后续可迁移到 SKILL.md frontmatter 的 requiresExecutor 字段；现阶段内联维护。
 */
export const REQUIRES_CLI_SKILLS: ReadonlySet<string> = new Set([
  'test-driven-development',
  'ci-cd-and-automation',
  'git-workflow-and-versioning',
  'shipping-and-launch',
  'browser-testing-with-devtools',
  'debugging-and-error-recovery',
  'performance-optimization',
  'security-and-hardening',
]);

/** 判断 skillId 是否需要 CLI 执行器。 */
export function skillRequiresCli(skillId: string): boolean {
  return REQUIRES_CLI_SKILLS.has(skillId);
}

export interface AssembledContext {
  systemPrompt: string;
  inputPacket: Record<string, unknown>;
  /** 上下文里明确引用的成果内容（path → content）。Phase 4 接入文件读取。 */
  referencedArtifacts: Record<string, string>;
  /** 本次加载且需要 CLI 执行能力的 skillId 列表（供引擎派发校验提示用）。 */
  loadedSkillsRequiringCli: string[];
}

export function assembleContext(
  db: DB,
  task: Task,
  options: {
    threadId?: string;
    sessionIdHint?: string;
    referencedArtifactPaths?: string[];
    /** Agent Bridge loopback 配置（注入到 systemPrompt 的能力清单）。 */
    loopback?: { baseUrl: string; taskId: string };
    /** 执行器类型：API 型无命令执行能力，桥接提示按此分化。 */
    executorKind?: 'cli' | 'api';
    /** 阶段二任务 2.3：API 型执行器是否具备命令执行能力（由能力探针判定）。undefined = 不按此分化。 */
    executorHasCommandCapability?: boolean;
    /** 轻量模式（咨询/讨论发言）：只注入身份/议题/职责/契约，跳过素材/技能/记忆/验收等大段上下文。 */
    lightweight?: boolean;
  } = {},
): AssembledContext {
  const project = getProject(db, task.projectId);
  const company = getCompany(db, project.companyId);
  const agent = task.assigneeAgentId ? getAgent(db, task.assigneeAgentId) : null;
  const lightweight = options.lightweight === true;

  // ===== System Prompt =====
  const sp: string[] = [];
  if (agent) {
    const profile = getAgentProfile(db, agent.profileId);
    sp.push('# 员工身份', profile.soul || profile.displayName, '');
    if (profile.principles.length > 0) sp.push('# 工作原则', profile.principles.map((item) => `- ${item}`).join('\n'), '');
  }
  // 轻量模式：身份/职责/议题之后直接进入输出契约，跳过组织级大段上下文
  if (!lightweight) {
    if (company.charter) {
      sp.push('# 公司章程', company.charter, '');
    }
    sp.push('# 项目说明', project.description || project.name, '');
  // 双 Loop 地基 P0.3：验收标准全程锚定——让 agent 明确"什么算好结果"。
  if (task.acceptanceCriteria.length > 0) {
    sp.push(
      '# 验收标准',
      '这是本任务"什么算好结果"的判定依据。你必须以此为准绳，完工时在 acceptanceMet 里逐条自评达标情况。',
      ...task.acceptanceCriteria.map((item) => {
        const tag = item.met === undefined ? '' : item.met ? ' [已达标]' : ' [未达标]';
        return `- [${item.id}] ${item.criterion}${tag}`;
      }),
      '',
    );
  } else {
    // 无验收标准时引导对齐：开始段若标准不充分，应发起有界对齐而非散点追问。
    sp.push(
      '# 验收标准',
      '本任务尚未明确验收标准。若关键结果无法判定，请在正式执行前用 outcome=waiting_input 一次性、结构化地提出对齐问题（聚焦补全"什么算好结果"），避免执行中反复打断用户。',
      '',
    );
  }
  }
  if (agent) {
    sp.push('# 你的职责', `岗位：${agent.role}`, agent.responsibilities || '', '');
    if (agent.stance) {
      sp.push(
        '# 你的立场',
        agent.stance,
        '在讨论和协作中，你必须坚持以上立场。即使其他员工持不同观点，也要从该立场出发论证。只有当证据明确反驳时才可有限度地调整。',
        '',
      );
    }
    if (agent.tools.length > 0) sp.push('# 可用能力声明', agent.tools.join('、'), '');
    if (agent.systemPrompt) sp.push(agent.systemPrompt);
  }
  // 轻量模式（咨询/讨论发言）：注入议题与前序发言后直接进入输出契约，跳过技能/能力中心/桥接/记忆/素材
  const loadedSkills: ResolvedTaskSkill[] = [];
  if (lightweight) {
    const proto = (task.inputProtocol ?? {}) as Record<string, unknown>;
    if (typeof proto.instruction === 'string' && proto.instruction) sp.push('# 本任务说明', proto.instruction, '');
    if (typeof proto.question === 'string' && proto.question) sp.push('# 待答复问题', proto.question, '');
    // 讨论发言：注入议题背景（topic + context），保证发言者看到完整议题
    if (typeof proto.topic === 'string' && proto.topic) sp.push('# 讨论议题', proto.topic, '');
    if (proto.context && typeof proto.context === 'object' && Object.keys(proto.context as Record<string, unknown>).length > 0) {
      sp.push('# 议题背景', JSON.stringify(proto.context, null, 2), '');
    }
    if (Array.isArray(proto.recentTurns) && proto.recentTurns.length > 0) {
      sp.push('# 前序发言', ...(proto.recentTurns as unknown[]).map((t) => `- ${String(t)}`), '');
    }
  } else {
  const resolvedSkills = resolveTaskSkills(db, task);
  loadedSkills.push(...resolvedSkills.filter((skill) => skill.status === 'loaded'));
  const skillDiagnostics = resolvedSkills.filter((skill) => skill.status !== 'loaded');
  if (loadedSkills.length > 0) {
    sp.push('# 本 Task 按需加载的 Skill');
    for (const skill of loadedSkills) {
      sp.push(`## ${skill.skillId}`, `来源：${skill.reason}`, skill.content ?? '', '');
    }
  }
  if (skillDiagnostics.length > 0) {
    sp.push(
      '# Skill 配置诊断',
      ...skillDiagnostics.map((skill) => `- ${skill.skillId}：${skill.status === 'missing' ? '未找到' : '已停用'}；原因：${skill.reason}`),
      '',
    );
  }
  // 能力中心:注入工具推荐(员工名下 capabilityBindings 的 recommendedToolIds)
  if (agent) {
    const toolRecommendations = resolveToolRecommendations(db, task);
    const capabilityCenter = buildCapabilityCenterSection(toolRecommendations);
    if (capabilityCenter) sp.push(capabilityCenter, '');
  }
  // 设计一-3：执行器能力边界提示（API 型按能力探针真实结果分化；具备命令能力的 API 不再被引导禁用 run_command）
  if (options.executorKind === 'api') {
    const cliOnlySkills = loadedSkills
      .map((skill) => skill.skillId)
      .filter((skillId) => REQUIRES_CLI_SKILLS.has(skillId));
    if (options.executorHasCommandCapability === true) {
      // 能力探针显示 function calling + 工具循环完整：允许使用 run_command，只提示沙盒边界
      sp.push(
        '# 执行器能力边界提示',
        '当前为 API 型执行器，但能力探针显示你具备命令执行能力（function calling + 工具循环完整）。',
        '你可以调用 run_command 在沙盒内执行命令（如 npm test、git status），命令会经过黑名单与权限审批；只读目录不可写入。',
        '',
      );
    } else if (cliOnlySkills.length > 0) {
      sp.push(
        '# 执行器能力边界提示',
        `当前为 API 型执行器，没有命令执行能力。以下技能依赖命令执行（测试/构建/git 等），你只能完成其中的设计/分析/编写部分，无法真正运行：${cliOnlySkills.join('、')}`,
        '如需完整执行（跑测试、构建、git 操作），请通知宿主连接 CLI 执行器（Codex CLI / Claude Code CLI 等）。',
        '',
      );
    } else {
      sp.push(
        '# 执行器能力边界提示',
        '当前为 API 型执行器，没有命令执行能力：不能安装依赖、运行测试、构建、git 操作、部署。请只完成文件读写与分析类工作。',
        '',
      );
    }
  }
  // Agent Bridge：注入桥接能力清单（让 Agent 可主动通知宿主进度）
  if (options.loopback) {
    sp.push(buildBridgePromptSection(options.loopback.baseUrl, options.executorKind), '');
  }

  // 会话压缩摘要（PRD Phase 3.6）：thread 经过压缩后保留的过往会话要点。
  if (options.threadId) {
    const compaction = db
      .prepare('SELECT compaction_summary FROM project_agent_thread WHERE id=?')
      .get(options.threadId) as { compaction_summary: string | null } | undefined;
    if (compaction?.compaction_summary) {
      sp.push('# 过往会话摘要（已压缩）', compaction.compaction_summary, '');
    }
  }
  if (agent) {
    // 渐进式加载：仅注入与当前任务相关的记忆（按 title/summary 做 FTS+LIKE 命中），
    // 而非全量塞入——避免上下文被无关记忆淹没。query 为空时 loadContextMemories 回退全量。
    const query = [task.title, task.summary].filter(Boolean).join(' ').slice(0, 120);
    const memories = loadContextMemories(db, {
      profileId: agent.profileId,
      companyId: company.id,
      projectId: project.id,
      query,
    });
    if (memories.length > 0) {
      sp.push('# 已批准的相关记忆', ...memories.map((memory) => `- [${memory.scope}] ${memory.content}`), '');
    }
  }
  // 项目素材清单:让员工知道项目有哪些素材可用(只注入摘要,不注入内容)
  const materials = listMaterials(db, project.id);
  if (materials.length > 0) {
    sp.push('# 项目素材', '你可以引用以下项目素材(通过路径或链接访问):');
    for (const m of materials) {
      const loc = m.storagePath ? `项目内 ${m.storagePath}` : (m.sourceUrl ?? '未知位置');
      sp.push(`- [${m.kind}] ${m.name} — ${loc}${m.tags.length ? ` (标签: ${m.tags.join(', ')})` : ''}`);
    }
    sp.push('');
  }
  } // else 闭合（非 lightweight 的完整上下文段）

  // 轻量任务（咨询/发言）用精简契约：无验收标准、无产物（产物会被系统剥离，必须走派活）
  if (lightweight) {
    sp.push(
      '# 输出契约',
      '你必须返回 JSON，符合 AgentRunResult 结构：',
      '{ outcome, summary, question?, outboundTasks[], artifacts[] }',
      'outcome ∈ completed | waiting_input | waiting_dependency | blocked',
      '信息不足时用 waiting_input + question 追问，不要编造。',
      '本任务为轻量任务（咨询/发言），不支持产出 artifacts（系统会剥离）；需要产出请用 done 的 outboundTasks 派发正式任务。',
      '',
    );
  } else {
    sp.push(
      '# 输出契约',
      '你必须返回 JSON，符合 AgentRunResult 结构：',
      '{ outcome, summary, question?, questionOptions?, outboundTasks[], artifacts[], checkpoint?, acceptanceMet? }',
      'outcome ∈ completed | waiting_input | waiting_dependency | blocked',
      '信息不足时用 waiting_input + question 在原 Task 中追问，不要编造。',
      '两难/需要用户拍板的选择题：用 questionOptions 给 2~4 个候选（id 稳定、label 简短、pros/cons 各一句），用户可一键选择；小问题自己定，不要什么都问。',
      'completed 时请在 acceptanceMet 里逐条自评验收标准（对照 # 验收标准 的 id，met=true/false）。',
      '',
    );
  }
  // 指挥系统 W3：调度中心专属——swarmPlan 契约教学（其他岗位不教，返回也会被忽略）
  if (agent?.isSystem && agent.role === DISPATCHER_ROLE) {
    sp.push(
      '# 蜂群契约（你是调度中心，独有）',
      '适合并行拆解的目标：在最终 JSON 里加 swarmPlan 字段并置 outcome="waiting_dependency"：',
      'swarmPlan: { goal: "总目标", workers: [ { title: "子题", brief: "给这只蜂的具体指令与边界" } ] }',
      '系统会为每只蜂创建一次性工蜂并行执行，全部完成后你收到 [蜂群汇总] 任务做收口报告。',
      '工蜂数量按需（够用就好）；超出系统上限会被截断。不适合并行的目标不要用 swarmPlan。',
      '',
    );
  }
  const systemPrompt = sp.join('\n');

  // ===== Input Packet =====
  const recentMessages = listTaskMessages(db, task.id).slice(-6);
  // 轻量模式：跳过 referencedArtifacts 全量加载（咨询/发言不需要引用大文件）
  const referencedArtifacts = lightweight ? {} : loadReferencedArtifacts(db, task);
  const companyAgents = listAgents(db, company.id);
  const availableContacts = lightweight ? [] : (agent
    ? agent.contactAllow.flatMap((contactId) => {
        const contact = companyAgents.find((candidate) => candidate.id === contactId);
        return contact
          ? [{ id: contact.id, name: contact.name, role: contact.role, responsibilities: contact.responsibilities }]
          : [];
      })
    : []);
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
  // 指挥系统：大规模并行任务的专职入口（调度中心是隐形岗，不在 availableContacts 里）
  if (!lightweight) {
    try {
      const dispatcherAgentId = getDispatcherAgentId(db, company.id);
      if (dispatcherAgentId) {
        inputPacket.swarmDispatcher = {
          id: dispatcherAgentId,
          name: '调度中心',
          usage: '需要大规模并行（大范围调研/信息扫描/批量评估）时，用 done 的 outboundTasks 派给此 id（recipientAgentId）；调度中心会拆解成工蜂群并行执行并汇总。',
        };
      }
    } catch {
      // 调度中心不存在时跳过（公司尚未上线生成）
    }
  }
  if (task.parentTaskId) {
    const parent = loadTask(db, task.parentTaskId);
    inputPacket.parentTask = { id: parent.id, seq: parent.seq, title: parent.title, summary: parent.summary };
  }
  // 工作流分支注入：让 Agent 知道当前节点有哪些可选出边
  const wfId = task.inputProtocol.workflowId as string | undefined;
  const wfNodeId = task.inputProtocol.workflowNodeId as string | undefined;
  if (wfId && wfNodeId) {
    try {
      const wf = getWorkflow(db, project.companyId, wfId);
      const branches = wf.edges
        .filter((e) => e.sourceId === wfNodeId)
        .map((e) => ({
          label: e.label,
          condition: describeCondition(e.condition),
          maxTraversals: e.maxTraversals,
        }));
      if (branches.length > 0) {
        inputPacket.workflowBranches = branches;
      }
    } catch {
      // workflow 可能未配置，忽略
    }
  }

  return {
    systemPrompt,
    inputPacket,
    referencedArtifacts,
    loadedSkillsRequiringCli: loadedSkills.map((s) => s.skillId).filter((id) => REQUIRES_CLI_SKILLS.has(id)),
  };
}

/** 人类可读的条件描述（注入给 Agent 辅助决策）。 */
function describeCondition(condition: EdgeCondition): string {
  switch (condition.type) {
    case 'always': return '无条件走此边';
    case 'auto_review': return `当 REVIEW_STATUS: ${condition.pass ? 'PASS' : 'FAIL'} 时走此边`;
    case 'outcome_equals': return `当 outcome=${condition.value} 时走此边`;
    case 'manual_approval': return '需要用户手动确认';
    case 'agent_label': return '由你在 workflowNextEdgeLabel 中返回此 label 选择';
    default: return '未知条件';
  }
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
