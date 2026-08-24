/**
 * 上下文装配器。
 *
 PRD：每次执行只装载公司章程、项目说明、员工职责、当前 Task 工作包和明确引用的成果。
 不把整份组织/流程定义塞入每次模型上下文。
 */
import type { DB } from '../db/client';
import type { ResolvedTaskSkill } from '../../shared/types';
import os from 'node:os';
import { getWorkbench } from '../domain/workbench';
import { getProject } from '../domain/project';
import { getAgent, listAgents, type AgentDefinition } from '../domain/agent';
import { ensureDispatcherAgentId, DISPATCHER_ROLE, JUDGE_ROLE, HR_ROLE, AUTOMATION_ROLE } from '../domain/system-agents';
import { listTaskMessages } from '../domain/task-message';
import type { Task } from '../domain/task';
import { getTask as loadTask } from '../domain/task';
import { getArtifactByPath } from '../domain/artifact';
import { readArtifactContent } from '../domain/artifact-content';
import { assertCanReadSource, listProjectReferences } from '../domain/project';
import { buildBridgePromptSection } from '../bridge';
import { getWorkflow, type EdgeCondition } from '../domain/workflow';
import { getAgentProfile } from '../domain/agent-profile';
import { loadContextMemories, expandMatchTokens } from '../domain/memory';
import { resolveTaskSkills } from '../domain/capability-binding';
import { resolveToolRecommendations, buildCapabilityCenterSection } from '../domain/tool-recommendation';
import { buildToolChainSection } from '../domain/tool-chain';
import { listMaterials } from '../domain/material';
import { getPersona, listPersonaIndex } from '../domain/persona-library';
import { appendTaskEvent } from '../domain/task-event';
import { searchArchive } from '../domain/archive';
import { listProjectSpecialists, listStaffSpecialists, specialistLabel } from '../domain/specialist-pool';
import { localTimezone } from '../domain/tz';
import { getExecutorProfile } from '../domain/executor-profile';

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
  /** 本次实际加载的全部 skillId（引擎持久化进 inputProtocol，任务条显示 chips——注入去黑盒）。 */
  loadedSkillIds: string[];
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
    /** WP10 识图直读：执行器是否声明图像理解能力（capabilities 含 vision）。 */
    executorVision?: boolean;
    /** 轻量模式（咨询/讨论发言）：只注入身份/议题/职责/契约，跳过素材/技能/记忆/验收等大段上下文。 */
    lightweight?: boolean;
    /** P1-② 全局软预算：执行器档案的上下文窗口（tokens）。systemPrompt 超预算时按段优先级压缩低优先段。 */
    contextWindowTokens?: number;
  } = {},
): AssembledContext {
  const project = getProject(db, task.projectId);
  const workbench = getWorkbench(db);
  const agent = task.assigneeAgentId ? getAgent(db, task.assigneeAgentId) : null;
  const lightweight = options.lightweight === true;

  // ===== System Prompt =====
  const sp: string[] = [];
  if (agent) {
    const profile = getAgentProfile(db, agent.profileId);
    sp.push('# 员工身份', profile.soul || profile.displayName, '');
    if (profile.principles.length > 0) sp.push('# 工作原则', profile.principles.map((item) => `- ${item}`).join('\n'), '');
  }

  // 批次 A：运行环境信息段（当前本地日期+星期+时刻、时区、OS/架构、执行器类型与 binary）
  const timeZone = localTimezone();
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(now);
  const getPart = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const dateStr = `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
  const timeStr = `${getPart('hour')}:${getPart('minute')}`;
  const weekdayStr = new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'long' }).format(now);
  const platformArch = `${process.platform}/${os.arch()}`;

  const executorKind = options.executorKind ?? 'cli';
  let binaryName = '';
  if (agent?.executorProfileId) {
    try {
      const ep = getExecutorProfile(db, agent.executorProfileId);
      if (ep?.config?.binaryPath && typeof ep.config.binaryPath === 'string') {
        // 只注 binary 名不注绝对路径（环境段只放平台事实，路径属工作区段）
        binaryName = ep.config.binaryPath.split('/').pop() ?? '';
      }
    } catch { /* 容错 */ }
  }

  sp.push(
    '# 运行环境',
    `当前时间：${dateStr} ${weekdayStr} ${timeStr} (${timeZone})`,
    `运行平台：${platformArch}`,
    `执行器类型：${executorKind}${binaryName ? ` (${binaryName})` : ''}`,
    '',
  );

  // 蓝图组织批次1：本次人设——身份层信息，轻量模式（咨询/讨论发言）同样注入。
  // persona 库可热变更：任务指定的 persona 已不存在时优雅跳过（不阻断执行），并留痕供专家沉淀管道观察缺什么专家。
  // 执行重试/会话恢复会重复装配上下文——同任务只留一次 persona_miss（查重防噪声）。
  // 我的人才：自有人才在岗（staffingMode=user_override）时其定制身份优先于官方 persona 注入。
  const persona = task.personaId ? getPersona(task.personaId) : null;
  if (task.personaId && !persona) {
    try {
      const seen = db.prepare(
        "SELECT 1 FROM task_event WHERE task_id=? AND kind='persona_miss' LIMIT 1",
      ).get(task.id);
      if (!seen) appendTaskEvent(db, task.id, 'persona_miss', { requestedPersonaId: task.personaId, scope: 'task_wear' });
    } catch { /* 留痕失败不阻断 */ }
  }
  const userOverride = task.inputProtocol.userTalentOverride as {
    profileId: string;
    displayName: string;
    soul: string;
    principles: string[];
  } | undefined;
  if (userOverride) {
    sp.push('# 本次人设（我的专属人才定制）', `你在本任务中穿戴用户定制人才「${userOverride.displayName}」，严格遵循以下定制身份与工作原则：`, userOverride.soul || '', '');
    if (userOverride.principles && userOverride.principles.length > 0) {
      sp.push('# 专属工作原则', userOverride.principles.map((item) => `- ${item}`).join('\n'), '');
    }
  } else if (persona) {
    sp.push('# 本次人设', `你在本任务中穿戴专家人设「${persona.name}」，以该领域的专业标准分析、决策与交付。`, persona.soul, '');
    if (persona.principles.length > 0) {
      sp.push('# 人设工作要点', persona.principles.map((item) => `- ${item}`).join('\n'), '');
    }
    const personaSkills = Array.isArray((persona.capabilities as { skills?: unknown })?.skills)
      ? (persona.capabilities as { skills: unknown[] }).skills.filter((s): s is string => typeof s === 'string')
      : [];
    if (personaSkills.length > 0) {
      sp.push('# 人设专长领域', personaSkills.slice(0, 12).join('、'), '');
    }
    // R1：人设声明的工具（注册表命中的会以完整推荐卡进入 # 能力中心，此处为文本兜底提示）。
    if (persona.tools.length > 0) {
      sp.push('# 人设工具', `本任务按「${persona.name}」人设推荐以下工具（CLI 执行器为原生工具集，API 执行器经工具循环调用）：`, persona.tools.join('、'), '');
    }
  }
  // 分身记忆快照（2026-08-24 蜂群分身专项）：蜂任务派发时注入的常驻专家只读薄手册——
  // 先穿身份、再领手册、再干活。快照不更新不回写；分身产出走汇总任务收口，不写入原专家的任何记忆。
  const memorySnapshot = (task.inputProtocol as { memorySnapshot?: unknown }).memorySnapshot;
  if (typeof memorySnapshot === 'string' && memorySnapshot.trim()) {
    sp.push(
      '# 常驻专家记忆快照（只读）',
      '你是上述专家的分身：以下是派群时刻的只读记忆快照（工作手册），用于延续其经验与判断风格。快照不会更新、也不会被回写——你的产出经汇总任务收口，不写入原专家的任何记忆。',
      memorySnapshot.trim(),
      '',
    );
  }
  // 打法包一期：协作班底（蓝图 2-4 槽）——不另起执行体，以协作成员提示注入
  const staffingNotes = (task.inputProtocol.staffingNotes ?? []) as Array<{ name: string; summary: string }>;
  if (staffingNotes.length > 0) {
    sp.push('# 协作班底', '本打法还包含以下协作成员，需要时可参考其领域分工（不另起执行体）：', staffingNotes.map((m) => `- ${m.name}${m.summary ? `：${m.summary}` : ''}`).join('\n'), '');
  }
  // 打法包读侧消费：蓝图战绩记账的常用工具注入上下文（CLI 原生工具集 / API 工具循环均可见）。
  const blueprintTools = (task.inputProtocol.blueprintTools ?? []) as string[];
  if (blueprintTools.length > 0) {
    sp.push('# 本打法常用工具', '这套打法历史上高频使用以下工具（按使用次数排序），优先考虑（推荐非门禁，按需取用）：', blueprintTools.slice(0, 10).join('、'), '');
  }
  // 轻量模式：身份/职责/议题之后直接进入输出契约，跳过组织级大段上下文
  if (!lightweight) {
    if (workbench.charter) {
      sp.push('# 工作台章程', workbench.charter, '');
    }
    sp.push('# 项目说明', project.description || project.name, '');
    // R3：worktree/发布语义教学——避免 agent 自行 merge/checkout 污染主干
    sp.push(
      '# 工作区与发布',
      '你在任务专属的隔离 git worktree 中工作，分支与合并由系统管理：',
      '1. 不要自行 git merge、push、checkout 主干或改动分支；',
      '2. 你产出的文件经系统发布管线三方合并到项目主干，冲突时系统会发起裁决；',
      '3. 需要版本控制时只做 git add/commit（提交即存档），提交信息保持简短。',
      '',
    );
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
  const taskProto = (task.inputProtocol ?? {}) as Record<string, unknown>;
  if (lightweight) {
    const proto = taskProto;
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
  // B3 用户意图锚点：任务契约的 goal/constraints/nonGoals（随链继承）——执行全程对齐"用户到底要什么、不做什么"。
  {
    const proto = (task.inputProtocol ?? {}) as Record<string, unknown>;
    const anchor = proto.intentAnchor as { goal?: unknown; constraints?: unknown } | undefined;
    const nonGoals = Array.isArray(proto.nonGoals) ? (proto.nonGoals as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const goal = anchor && typeof anchor.goal === 'string' ? anchor.goal : '';
    const constraints = anchor && Array.isArray(anchor.constraints)
      ? (anchor.constraints as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (goal || nonGoals.length > 0 || constraints.length > 0) {
      sp.push('# 用户意图锚点', '');
      if (goal) sp.push(`目标：${goal.slice(0, 300)}`);
      if (constraints.length > 0) sp.push(`约束：${constraints.slice(0, 5).join('；')}`);
      if (nonGoals.length > 0) sp.push(`不做（非目标）：${nonGoals.slice(0, 5).join('；')}`);
      sp.push('执行与交付均不得偏离上述锚点；认为需要偏离时先说明理由并征求确认。', '');
    }
  }
  // 能力中心:注入工具推荐(员工名下 capabilityBindings 的 recommendedToolIds)
  // B3 能力管理：有 resolvedToolChain 决议时消费快照（四层合并+质量排序+挑战建议，默认套装提示），
  // 无决议回退原全量平铺（零回归）。
  if (agent) {
    const resolved = (task.inputProtocol as Record<string, unknown>).resolvedToolChain as
      | { defaultKit?: unknown; tools?: unknown; suggestedReplacements?: unknown }
      | undefined;
    const chainSection = resolved && Array.isArray(resolved.tools)
      ? buildToolChainSection(resolved)
      : null;
    if (chainSection) {
      sp.push(chainSection, '');
    } else {
      const toolRecommendations = resolveToolRecommendations(db, task);
      const capabilityCenter = buildCapabilityCenterSection(toolRecommendations);
      if (capabilityCenter) sp.push(capabilityCenter, '');
    }
  }
  // 设计一-3：执行器能力边界提示（API 型按能力探针真实结果分化；具备命令能力的 API 不再被引导禁用 run_command）
  if (options.executorKind === 'api') {
    // WP10 识图双路：带图片但执行器未声明 vision → 引导走路径/OCR 工具，禁止假装看图
    const userImages = Array.isArray((task.inputProtocol as Record<string, unknown>).userImages)
      ? (task.inputProtocol.userImages as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (userImages.length > 0 && options.executorVision !== true) {
      sp.push(
        '# 图像输入提示',
        `本任务附带 ${userImages.length} 张用户图片，但当前执行器未声明图像理解能力（capabilities 不含 vision）。图片以文件路径列在【用户附件】中（CLI 型可直接读取图片文件）；如需理解图片内容请使用图像理解/OCR 类工具，不要在没有真正看到图片的情况下编造其内容。`,
        '',
      );
    }
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
      projectId: project.id,
      personaKey: task.personaId,
      query,
      // 记忆优势分：注入记账（任务终态时按项目基线投票）。
      taskId: task.id,
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
  // 蓝图组织批次2：跨项目归档检索——旧项目的已审批经验/调研结论/成果元数据与当前任务相关时注入。
  // 只读参考：不改变权限；旧项目成果文件不自动授权读取（需要时由用户经 project_reference 显式授权）。
  const archiveQuery = [task.title, task.summary].filter(Boolean).join(' ').slice(0, 120);
  if (archiveQuery) {
    const archiveHits = searchArchive(db, {
      companyId: workbench.id,
      excludeProjectId: project.id,
      query: archiveQuery,
      limit: 5,
    });
    if (archiveHits.length > 0) {
      sp.push('# 相关旧档', '以下旧项目的归档与当前任务相关，可作参考（以当前项目为准；成果文件未授权读取）：');
      for (const hit of archiveHits) {
        const kindLabel = hit.kind === 'memory' ? '经验' : hit.kind === 'research' ? '调研' : '成果';
        sp.push(`- [${kindLabel}·${hit.projectName}] ${hit.text}`);
      }
      sp.push('');
    }
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
      'outboundTasks[].title 用动宾短语：中文 ≤ 14 字、英文 ≤ 28 字符，不加句号（标题要能在一行列表里显示完整）。',
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
      'outboundTasks[].title 用动宾短语：中文 ≤ 14 字、英文 ≤ 28 字符，不加句号（标题要能在一行列表里显示完整）；swarmPlan.workers[].title 同此约定。',
      '',
    );
  }
  // 指挥系统 W3 + 组织模型批次二：养蜂人/人事专属——人设库索引注入
  // （选蜂/建专家都要按目录选人设，persona_miss 的根治）。
  if (agent?.isSystem && (agent.role === DISPATCHER_ROLE || agent.role === HR_ROLE)) {
    const personaIndex = listPersonaIndex();
    if (personaIndex.length > 0) {
      const totalPersonas = personaIndex.reduce((n, d) => n + d.items.length, 0);
      // P1-② 上下文成本治理：库大时只注入与任务相关的 top-k（词法计分），并给"另有 N 位"计数提示；
      // 库小（≤15）保留全量（旧行为）。此前整库逐条注入，随人设沉淀线性膨胀挤占窗口。
      const prunedIndex = totalPersonas > 15 ? selectRelevantPersonaDomains(personaIndex, task.title, 8) : personaIndex;
      const shownCount = prunedIndex.reduce((n, d) => n + d.items.length, 0);
      sp.push(
        '# 人设库索引（选人设用）',
        '为工蜂/新专家挑选 personaId 时从以下目录取（id 必须与目录逐字一致）；没有合适的就省略 personaId（匿名蜂/通用专家），不要编造目录外的 id：',
        ...(totalPersonas > shownCount
          ? [`（按任务相关性显示 ${shownCount}/${totalPersonas} 位——若都不合适，可在 summary 里说明所需专长特征，系统下次补充）`]
          : []),
        ...prunedIndex.flatMap((d) => [
          `## ${d.domain}（${d.items.length} 位）`,
          ...d.items.map((i) => `- ${i.id} — ${i.name}${i.description ? `：${i.description}` : ''}`),
        ]),
        '',
      );
    }
  }
  // 指挥系统 W3：养蜂人专属——swarmPlan 契约教学（其他岗位不教，返回也会被忽略）
  if (agent?.isSystem && agent.role === DISPATCHER_ROLE) {
    sp.push(
      '# 蜂群契约（你是养蜂人，独有）',
      '适合并行拆解的目标：在最终 JSON 里加 swarmPlan 字段并置 outcome="waiting_dependency"：',
      'swarmPlan: { goal: "总目标", workers: [ { title: "子题", brief: "给这只蜂的具体指令与边界", personaId?: "子题要求的专家人设" } ] }',
      '系统会为每只蜂创建一次性工蜂并行执行，全部完成后你收到 [蜂群汇总] 任务做收口报告。收口报告必须包含「结论」「分歧」「风险」三段标题（无分歧须显式写明"无分歧"）。',
      'workers 排序按「由简入繁」：简单子题排前面先跑，为复杂子题铺平上下文与依赖事实。',
      '工蜂数量按需（够用就好）；超出系统上限会被截断。不适合并行的目标不要用 swarmPlan。',
      '四种蜂型（按目标特征选）：① 匿名蜂群（全部省 personaId）——机械并行、抓取粗筛；② 同种专家群（全部 worker 同一 personaId）——同专长领不同任务切片，上下文差异产生不同见解，适合方案探索/多角度评审；③ 异种专家团（不同 personaId 各管一段）——专业互补的流水协作；④ 混编（部分带部分不带）——专家做关键节点、匿名蜂做支撑。',
      '专家蜂不占用常驻真人：命中项目专家也会以其分身入群（穿戴人设+只读记忆快照，并行无排队），可放心按需同 persona 多蜂。',
      '',
    );
  }
  // 批次 D：蜂群收口结构契约教学（汇总任务专属）
  if (taskProto.swarmSynthesis === true || task.title.startsWith('[蜂群汇总]')) {
    sp.push(
      '# 蜂群收口结构契约（你是汇总任务执行者，三段必需）',
      '你正在执行蜂群收口汇总任务。完成时的 summary 必须显式包含以下三段标题行结构：',
      '1. 「## 结论」：精炼概括全群产出与目标达成度；',
      '2. 「## 分歧」：汇总各工蜂/专家间的分歧点与裁决结论（若各方一致无分歧，请显式写明"无分歧"）；',
      '3. 「## 风险」：指出遗留风险、未决事项或后续建议。',
      '若缺失任意一段标题，系统会在结果中标注契约违约留痕。',
      '',
    );
  }
  // 整改计划 Part2 批次5：自动化管家专属——automationPlan 契约 + 可绑定项目清单
  if (agent?.isSystem && agent.role === AUTOMATION_ROLE) {
    const bindableProjects = db.prepare("SELECT id, name FROM project WHERE state IN ('active','draining') AND COALESCE(settings_json,'') NOT LIKE '%inbox%' ORDER BY created_at DESC LIMIT 20").all() as Array<{ id: string; name: string }>;
    sp.push(
      '# 自动化契约（你是自动化管家，独有）',
      '用户想在自动化页创建自动化时：先问清缺的信息（仓库 / 绑定项目 / 节奏），齐了在最终 JSON 里加 automationPlan 字段并置 outcome="completed"：',
      'automationPlan: { "kind": "github-issues", "config": { "repo": "owner/repo", "labelFilter": "可选" },',
      '  "schedule": { "kind": "interval", "intervalMinutes": 60 } 或 { "kind": "daily", "timeOfDay": "09:00" },',
      '  "projectId": "从下方项目清单选" }',
      '一期仅支持 github-issues（定时拉取仓库的开放 Issues，分派给绑定负责人处理）。信息不全时 outcome="waiting_input" 向用户提问。',
      '',
      '# 可绑定项目',
      ...(bindableProjects.length > 0
        ? bindableProjects.map((bp) => `- ${bp.name}（${bp.id}）`)
        : ['（暂无可绑定项目——请用户先创建项目）']),
      '',
    );
  }
  // 组织模型批次二：人事岗专属——专家池清单 + 专家供给契约
  if (agent?.isSystem && agent.role === HR_ROLE) {
    const projectSpecialists = listProjectSpecialists(db, project.id);
    const staffSpecialists = listStaffSpecialists(db, project.id);
    // P1-② 上下文成本治理：池大时只注入与任务相关的 top-k（词法计分 specialty 命中），
    // 池小（合计 ≤15）保留全量（旧行为）。
    const specialistTotal = projectSpecialists.length + staffSpecialists.length;
    const pickTop = <T>(list: T[], keyOf: (item: T) => string, k: number): T[] => {
      if (specialistTotal <= 15 || list.length <= k) return list;
      const tokens = expandMatchTokens(task.title);
      return [...list]
        .map((item, index) => ({ item, index, score: tokens.reduce((n, t) => n + (keyOf(item).toLowerCase().includes(t) ? 1 : 0), 0) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, k)
        .map((x) => x.item);
    };
    const shownProject = pickTop(projectSpecialists, (s) => `${s.specialty} ${specialistLabel(db, s)}`, 10);
    const shownStaff = pickTop(staffSpecialists, (s) => `${s.specialty} ${specialistLabel(db, s)}`, 10);
    sp.push(
      '# 专家池清单（你能供给的专家）',
      ...(specialistTotal > shownProject.length + shownStaff.length
        ? [`（按任务相关性显示 ${shownProject.length + shownStaff.length}/${specialistTotal} 位专家——不合适时按契约新建）`]
        : []),
      ...(shownProject.length > 0
        ? [
          '项目已有专家（优先建议复用，不要重复建）：',
          ...shownProject.map((s) => `- ${specialistLabel(db, s)} — ${s.specialty}（已用 ${s.useCount} 次${s.tier === 'staff' ? '，常驻专家' : ''}）`),
        ]
        : ['（本项目暂无专家，需要时按契约新建）']),
      ...(shownStaff.length > 0
        ? ['全局常驻专家（跨项目可借，建议复用）：', ...shownStaff.map((s) => `- ${specialistLabel(db, s)} — ${s.specialty}（他项目）`)]
        : []),
      '',
      '# 专家供给契约（你是人事，独有）',
      '确认缺人时，在最终 JSON 里加 staffingPlan 字段：',
      'staffingPlan: { specialists: [ { specialty: "专长描述", personaId?: "建议穿戴的人设 id（从人设库索引选）", brief: "职责说明" } ] }',
      '系统会为每位专家建立项目专家：常驻本项目、跨任务复用、只加不减，建好后出现在花名册即可被派遣。',
      '能复用已有专家/我的 talent 时不要新建——在 summary 里点名建议复用即可。',
      '',
    );
  }
  // 指挥系统批次4：裁决法庭专属——debateVerdict 契约教学
  if (agent?.isSystem && agent.role === JUDGE_ROLE) {
    sp.push(
      '# 裁决契约（你是裁决法庭，独有）',
      '在最终 JSON 里加 debateVerdict 字段：',
      'debateVerdict: { recommendedOptionId: "推荐选项id（都不推荐则省略）", confidence: 0~1, rationale: "理由", flaws: [ { optionId, flaw: "该选项的致命伤——最坏会发生什么、能否接受" } ] }',
      '置信 ≥ 阈值会自动采纳并继续执行；低于阈值转用户拍板。各辩手的立论/互攻材料在你的任务讨论流（[上游输出]）里。',
      '若输入带 userDecisions（用户历史选择），尊重其偏好方向。',
      '',
    );
  }
  // P1-② 全局软预算（最后防线）：各段独立 cap 之外，整体超预算时按优先级压缩低优先段——
  // 身份/人设/职责/验收/契约永不动；先压旧档/素材/目录类长尾段。
  const softCharBudget = clampSoftPromptBudget(options.contextWindowTokens);
  const trimmedSp = trimPromptSections(sp, softCharBudget);
  const systemPrompt = trimmedSp.join('\n');

  // ===== Input Packet =====
  // 蜂群汇总：每只蜂完成时把 [蜂成员汇报] 逐条写进汇总任务消息（reportBeeCompletion）。
  // 固定 6 条窗口在蜂数 >6 时会丢早期汇报——按蜂数扩窗（蜂汇报全保留 + 4 条系统消息余量）。
  const swarmBeeCount = taskProto.swarmSynthesis === true
    ? Number((taskProto.swarm as { beeCount?: number } | undefined)?.beeCount ?? 0)
    : 0;
  const allMessages = listTaskMessages(db, task.id);
  const recentMessages = swarmBeeCount > 0
    ? allMessages.slice(-Math.max(6, swarmBeeCount + 4))
    : allMessages.slice(-6);
  // 轻量模式：跳过 referencedArtifacts 全量加载（咨询/发言不需要引用大文件）
  const referencedArtifacts = lightweight ? {} : loadReferencedArtifacts(db, task);
  const companyAgents = listAgents(db);
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
  // WP10 识图直读：data-uri 图片不进提示词 JSON 块（否则 base64 灌满所有执行器的输入包，API 执行器双重携带）；
  // 图片经 ctx.imageAttachments 由 adapter 原生送入，文件路径提示已在【用户附件】文本里。
  delete inputPacket.userImages;
  // 链路双指向（B1）：链路历史压缩为标题路径注入（taskId/agentId 是机器标识，对模型无信息量；
  // 完整 hop 结构留在 task.inputProtocol 供审计，不进提示词）。
  if (Array.isArray(inputPacket.chainHistory)) {
    inputPacket.chainPath = (inputPacket.chainHistory as Array<{ title: string }>)
      .slice(-10)
      .map((h) => h.title);
    delete inputPacket.chainHistory;
  }
  // B3 审查修复：装备决议快照不进提示词 JSON——# 装备决议 段已渲染（对齐 userImages 先例，防双重携带）
  delete inputPacket.resolvedToolChain;
  // 指挥系统：大规模并行任务的专职入口（养蜂人是隐形岗，不在 availableContacts 里）
  // 蓝图组织批次4e：懒确保——与公司上线时机解耦，首次装配上下文即自愈创建（幂等）。
  if (!lightweight) {
    try {
      inputPacket.swarmDispatcher = {
        id: ensureDispatcherAgentId(db),
        name: '养蜂人',
        usage: '需要大规模并行（大范围调研/信息扫描/批量评估）时，用 done 的 outboundTasks 派给此 id（recipientAgentId）；养蜂人会拆解成工蜂群并行执行并汇总。',
      };
    } catch {
      // 防御：创建工作台异常时跳过注入，不阻断任务执行
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
      const wf = getWorkflow(db, workbench.id, wfId);
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
    loadedSkillIds: loadedSkills.map((s) => s.skillId),
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

// ===== P1-② 上下文成本治理辅助 =====

/** 人设库词法 top-k：按任务标题在人设 id/name/description 上的词元命中数排序，保留分组结构。 */
function selectRelevantPersonaDomains(
  index: Array<{ domain: string; items: Array<{ id: string; name: string; description?: string | null }> }>,
  taskTitle: string,
  topK: number,
): Array<{ domain: string; items: Array<{ id: string; name: string; description?: string | null }> }> {
  const tokens = expandMatchTokens(taskTitle);
  const flat = index.flatMap((d) => d.items.map((i) => ({ id: i.id, name: i.name, description: i.description, domain: d.domain })));
  const ranked = flat
    .map((item, order) => {
      const haystack = `${item.id} ${item.name} ${item.description ?? ''}`.toLowerCase();
      return { id: item.id, order, score: tokens.reduce((n, t) => n + (haystack.includes(t) ? 1 : 0), 0) };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const keep = new Set(ranked.slice(0, topK).map((r) => r.id));
  return index
    .map((d) => ({ domain: d.domain, items: d.items.filter((i) => keep.has(i.id)) }))
    .filter((d) => d.items.length > 0);
}

/** 软预算折算：窗口 tokens 的 25% 作字符预算（中文 1 字≈1-2 token 的保守折算），夹在 [16k, 48k]。 */
function clampSoftPromptBudget(contextWindowTokens?: number): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) return 32_000;
  return Math.min(48_000, Math.max(16_000, Math.floor(contextWindowTokens / 4)));
}

/** 低优先段（超预算时按序压缩为"段头+省略提示"）；身份/人设/职责/验收/契约段永不动。 */
const LOW_PRIORITY_SECTIONS = ['# 相关旧档', '# 项目素材', '# 人设库索引（选人设用）', '# 专家池清单（你能供给的专家）'];

/** 全局守门（最后防线）：整体超预算时按 LOW_PRIORITY_SECTIONS 顺序逐段压缩，直到达标或压完。 */
export function trimPromptSections(sp: string[], charBudget: number): string[] {
  if (sp.join('\n').length <= charBudget) return sp;
  const working = [...sp];
  for (const header of LOW_PRIORITY_SECTIONS) {
    if (working.join('\n').length <= charBudget) break;
    const idx = working.indexOf(header);
    if (idx === -1) continue;
    let end = working.length;
    for (let i = idx + 1; i < working.length; i++) {
      if (working[i]!.startsWith('# ')) { end = i; break; }
    }
    if (end - idx <= 2) continue; // 段本来就小，压了没收益
    working.splice(idx, end - idx, header, '（本段内容超预算已压缩省略——需要完整清单时请说明，系统会在下轮补充）', '');
  }
  return working;
}
