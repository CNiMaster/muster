/**
 * 讨论室 domain（设计二-方案B）：项目级多员工异步串行探讨。
 *
 * 机制：
 * - 讨论 = 多个参与者按顺序轮流发言（同一时刻仅一个发言者）。
 * - 每次发言 = 一个特殊 task（inputProtocol 带 discussion:true），assignee=当前发言者。
 * - 发言完成后引擎调 completeDiscussionTurn → 创建下一个发言者的 task（轮转）。
 * - 所有参与者都发完一轮后，可继续下一轮或由发起者/moderator conclude。
 * - conclude 时写纪要 + 结论，结论可派发实施 task / 写项目 memory / 产出 artifact。
 *
 * 与 ask_colleague 的区别：ask_colleague 是单轮单向咨询（A 问 B 答）；
 * discussion 是多轮多向探讨（N 人轮流发言，可来回多轮，最后压缩结论）。
 *
 * 防护：max_turns 上限（默认 12）、参与者必须同公司、context_refs 路径校验。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { createTask, getTask } from './task';
import { getAgent } from './agent';
import { getProject } from './project';
import { postSystemMessage } from './conversation';
import { createMirror, removeMirror, listMirrorsOfRoot, ensurePrimaryThread } from './thread';
import { getWorkbench } from './workbench';
import { BREADTH_LIMITS, taskBreadthTier } from './breadth-tier';
import { CENTRAL_STAFF_ROLES } from './system-agents';
import { createMemoryCandidate } from './memory';

export type DiscussionState = 'open' | 'concluding' | 'concluded' | 'closed';
export type ParticipantRole = 'member' | 'moderator';

/**
 * 讨论场景（7 类）—— 决定谁能发起、谁参加、结论如何落地。
 * 本质：单个 agent 无法独立决策、需要多方信息/共识时触发。
 */
export type DiscussionScenario =
  | 'help-request'        // 遇到难题求助：执行者发起，相关专家+可选领导，集思广益→派实施 task
  | 'task-clarification'  // 对任务存疑：执行者发起，派发者+同事，对齐理解→更新验收标准
  | 'quality-review'      // 结果不满意评审：领导/moderator 发起，产出者+评审者，改进→派返工 task
  | 'task-breakdown'      // 任务过大需细分：领导/moderator 发起，相关岗位，分工→派子 task
  | 'standard-alignment'  // 传达统一约定：领导/moderator 发起，全员或指定组，对齐→写记忆
  | 'conflict-resolution' // 发布/产物冲突：引擎自动/领导发起，冲突方+裁决者，裁决→选定版本
  | 'brainstorm';         // 探索性/无明确方案：任何人发起，自愿参与，创意→建议 task

export interface DiscussionScenarioConfig {
  /** 谁可以发起（role 关键词，运行时校验 agent.role 是否匹配）。 */
  allowedInitiatorRoles: string[];
  /** 默认参与者规则描述（供 UI 建议参与者的提示）。 */
  participantGuidance: string;
  /** 结论落地方式描述。 */
  conclusionAction: string;
  /** 场景说明。 */
  description: string;
}

export const DISCUSSION_SCENARIOS: Record<DiscussionScenario, DiscussionScenarioConfig> = {
  'help-request': {
    allowedInitiatorRoles: ['*'],
    participantGuidance: '相关领域专家 + 可选领导（负责人）',
    conclusionAction: '集思广益，派发实施 task 给求助者',
    description: '遇到难题求助：执行者卡住，需要多方意见突破',
  },
  'task-clarification': {
    allowedInitiatorRoles: ['*'],
    participantGuidance: '任务派发者 + 同岗位同事',
    conclusionAction: '对齐理解，更新 task 验收标准或派发澄清 task',
    description: '对任务需求/验收标准存疑，需要澄清',
  },
  'quality-review': {
    allowedInitiatorRoles: ['lead', 'manager', 'moderator', 'reviewer', 'editor'],
    participantGuidance: '产出者 + 评审者 + 可选领导',
    conclusionAction: '评审改进，派发返工 task',
    description: '产出未达验收标准，需要评审与改进建议',
  },
  'task-breakdown': {
    allowedInitiatorRoles: ['lead', 'manager', 'moderator', 'planner'],
    participantGuidance: '相关岗位负责人',
    conclusionAction: '规划分工，派发子 task 给各岗位',
    description: '任务过大需要细分为可执行子任务',
  },
  'standard-alignment': {
    allowedInitiatorRoles: ['lead', 'manager', 'moderator'],
    participantGuidance: '全员或指定组',
    conclusionAction: '统一约定，写入公司/项目记忆',
    description: '多员工对同一标准理解不一，需要传达统一约定',
  },
  'conflict-resolution': {
    allowedInitiatorRoles: ['lead', 'manager', 'moderator', '*'], // * 允许引擎自动触发
    participantGuidance: '冲突方 + 裁决者（负责人）',
    conclusionAction: '裁决方案，选定版本或派发合并 task',
    description: '发布冲突或产物冲突，需要协调解决',
  },
  'brainstorm': {
    allowedInitiatorRoles: ['*'],
    participantGuidance: '自愿参与的任何员工',
    conclusionAction: '创意汇总，形成建议 task（不直接执行）',
    description: '探索性议题，无明确方案需要头脑风暴',
  },
};

export type DiscussionMode = 'sequential' | 'parallel';

export interface Discussion {
  id: string;
  projectId: string;
  companyId: string;
  topic: string;
  initiatorAgentId: string | null;
  state: DiscussionState;
  /** 阶段七任务 7.3：讨论模式（sequential 串行 / parallel 同轮并行 + moderator 汇总）。 */
  mode: DiscussionMode;
  currentSpeakerAgentId: string | null;
  currentTurnTaskId: string | null;
  turnCount: number;
  maxTurns: number;
  context: Record<string, unknown>;
  minutes: string | null;
  conclusion: DiscussionConclusion | null;
  sourceTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DiscussionParticipant {
  discussionId: string;
  agentId: string;
  role: ParticipantRole;
  turnIndex: number;
  joinedAt: string;
}

export interface DiscussionTurn {
  id: string;
  discussionId: string;
  taskId: string;
  speakerAgentId: string;
  turnIndex: number;
  content: string | null;
  createdAt: string;
}

export interface DiscussionConclusion {
  keyPoints: string[];
  /** 落地动作：派发实施 task。 */
  actions: Array<{ title: string; assigneeAgentId?: string; payload?: Record<string, unknown> }>;
  /** 写入项目 memory 的要点。 */
  memoryNotes: string[];
}

interface DiscussionRow {
  id: string; project_id: string; topic: string; initiator_agent_id: string | null;
  state: DiscussionState; current_speaker_agent_id: string | null; current_turn_task_id: string | null;
  turn_count: number; max_turns: number; context_json: string; minutes: string | null; conclusion_json: string | null;
  source_task_id: string | null; mode: DiscussionMode | null; created_at: string; updated_at: string;
}
interface ParticipantRow { discussion_id: string; agent_id: string; role: ParticipantRole; turn_index: number; joined_at: string }
interface TurnRow { id: string; discussion_id: string; task_id: string; speaker_agent_id: string; turn_index: number; content: string | null; created_at: string }

function fromRow(db: DB, r: DiscussionRow): Discussion {
  return {
    id: r.id, projectId: r.project_id, companyId: getWorkbench(db).id, topic: r.topic,
    initiatorAgentId: r.initiator_agent_id, state: r.state,
    currentSpeakerAgentId: r.current_speaker_agent_id, currentTurnTaskId: r.current_turn_task_id,
    turnCount: r.turn_count, maxTurns: r.max_turns, context: JSON.parse(r.context_json ?? '{}'),
    minutes: r.minutes, conclusion: r.conclusion_json ? JSON.parse(r.conclusion_json) : null,
    sourceTaskId: r.source_task_id,
    mode: (r.mode ?? 'sequential') as DiscussionMode,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function getDiscussion(db: DB, id: string): Discussion {
  const row = db.prepare('SELECT * FROM discussion WHERE id=?').get(id) as DiscussionRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `讨论室不存在: ${id}`);
  return fromRow(db, row);
}

export function listDiscussions(db: DB, projectId: string, state?: DiscussionState): Discussion[] {
  const rows = state
    ? db.prepare('SELECT * FROM discussion WHERE project_id=? AND state=? ORDER BY created_at DESC').all(projectId, state) as DiscussionRow[]
    : db.prepare('SELECT * FROM discussion WHERE project_id=? ORDER BY created_at DESC').all(projectId) as DiscussionRow[];
  return rows.map((row) => fromRow(db, row));
}

export function listParticipants(db: DB, discussionId: string): DiscussionParticipant[] {
  const rows = db.prepare('SELECT * FROM discussion_participant WHERE discussion_id=? ORDER BY turn_index').all(discussionId) as ParticipantRow[];
  return rows.map((r) => ({ discussionId: r.discussion_id, agentId: r.agent_id, role: r.role, turnIndex: r.turn_index, joinedAt: r.joined_at }));
}

export function listTurns(db: DB, discussionId: string): DiscussionTurn[] {
  const rows = db.prepare('SELECT * FROM discussion_turn WHERE discussion_id=? ORDER BY turn_index').all(discussionId) as TurnRow[];
  return rows.map((r) => ({ id: r.id, discussionId: r.discussion_id, taskId: r.task_id, speakerAgentId: r.speaker_agent_id, turnIndex: r.turn_index, content: r.content, createdAt: r.created_at }));
}

/**
 * 校验发起者角色是否符合场景要求。
 * allowedInitiatorRoles 含 '*' 表示任何角色可发起。
 * 无 initiatorAgentId 时不校验（允许系统自动触发）。
 */
function initiatorAgentIdValid(initiatorAgentId: string | undefined, db: DB, config: DiscussionScenarioConfig): boolean | false {
  if (!initiatorAgentId) return true; // 系统触发无发起者
  if (config.allowedInitiatorRoles.includes('*')) return true;
  try {
    const agent = getAgent(db, initiatorAgentId);
    return config.allowedInitiatorRoles.some((role) => agent.role.toLowerCase().includes(role.toLowerCase()));
  } catch {
    return false;
  }
}

/**
 * 创建讨论室（不立即启动发言；调 startDiscussion 开始第一轮）。
 * 参与者按传入顺序决定发言轮转顺序；第一个为 moderator（通常是发起者）。
 * scenario 决定发起者角色校验与结论落地建议。
 */
export function createDiscussion(db: DB, input: {
  projectId: string;
  topic: string;
  participantAgentIds: string[];
  initiatorAgentId?: string;
  context?: Record<string, unknown>;
  maxTurns?: number;
  sourceTaskId?: string;
  scenario?: DiscussionScenario;
  /** 阶段七任务 7.3：sequential（串行）/ parallel（同轮并行 + moderator 汇总），默认 sequential。 */
  mode?: DiscussionMode;
}): Discussion {
  const project = getProject(db, input.projectId);
  const scenario = input.scenario ?? 'help-request';
  const scenarioConfig = DISCUSSION_SCENARIOS[scenario];
  // 场景角色校验：非 * 的场景要求发起者角色匹配
  if (initiatorAgentIdValid(input.initiatorAgentId, db, scenarioConfig) === false) {
    throw new AppError(ErrorCode.UNAUTHORIZED, `场景 ${scenario} 要求发起者角色为 ${scenarioConfig.allowedInitiatorRoles.join('/')}（当前员工不匹配）`);
  }
  if (input.participantAgentIds.length < 2) throw new AppError(ErrorCode.VALIDATION, '讨论至少需要 2 个参与者');
  if (input.participantAgentIds.length > 8) throw new AppError(ErrorCode.VALIDATION, '讨论参与者上限 8 人');
  // 校验参与者同公司 + 去重保持顺序
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of input.participantAgentIds) {
    if (seen.has(id)) continue;
    const agent = getAgent(db, id);
    if (agent.companyId !== project.companyId) throw new AppError(ErrorCode.UNAUTHORIZED, `员工 ${id} 不属于项目所在公司`);
    seen.add(id);
    ordered.push(id);
  }
  const id = shortId('disc_');
  const now = nowIso();
  const contextWithScenario = { ...(input.context ?? {}), scenario, scenarioGuidance: scenarioConfig.conclusionAction };
  // 三档广深（B2）：发言轮次默认随源任务档位（轻=6/中=12/重=20；聊完即收，不为走满轮次）——
  // 显式 maxTurns 优先；无源任务（用户直接发起）按工作台默认档。
  const maxTurnsDefault = (() => {
    let proto: Record<string, unknown> | undefined;
    if (input.sourceTaskId) {
      try {
        proto = (getTask(db, input.sourceTaskId).inputProtocol ?? {}) as Record<string, unknown>;
      } catch { /* 源任务缺失回落工作台默认档 */ }
    }
    return BREADTH_LIMITS[taskBreadthTier(db, proto)].discussionMaxTurns;
  })();
  db.prepare(`INSERT INTO discussion (id,project_id,topic,initiator_agent_id,state,max_turns,context_json,source_task_id,mode,created_at,updated_at) VALUES (?,?,?,?, 'open', ?, ?, ?, ?, ?, ?)`)
    .run(id, project.id, input.topic, input.initiatorAgentId ?? null, input.maxTurns ?? maxTurnsDefault, JSON.stringify(contextWithScenario), input.sourceTaskId ?? null, input.mode ?? 'sequential', now, now);
  // 注册参与者（第一个是 moderator）
  ordered.forEach((agentId, idx) => {
    db.prepare('INSERT INTO discussion_participant (discussion_id,agent_id,role,turn_index,joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, agentId, idx === 0 ? 'moderator' : 'member', idx, now);
  });
  // 分身参与：为每个参与者自动创建 mirror thread（不阻塞主任务）。
  // reuseIdle=true：复用空闲分身，每员工每项目最多 1 个空闲分身，防止失控。
  for (const agentId of ordered) {
    try { createMirror(db, project.id, agentId, { reuseIdle: true }); } catch { /* 分身创建失败不阻塞讨论 */ }
  }
  return getDiscussion(db, id);
}

/**
 * 启动讨论：为第一个参与者创建发言 task。
 * 若已有进行中的发言 task 则不重复创建。
 */
export function startDiscussion(db: DB, discussionId: string): { discussion: Discussion; turnTaskId: string } {
  const disc = getDiscussion(db, discussionId);
  if (disc.state !== 'open') throw new AppError(ErrorCode.CONFLICT, `讨论室状态 ${disc.state}，无法启动`);
  if (disc.currentTurnTaskId) throw new AppError(ErrorCode.CONFLICT, '讨论已启动，存在进行中的发言');
  if (disc.turnCount >= disc.maxTurns) throw new AppError(ErrorCode.CONFLICT, `已达发言上限 ${disc.maxTurns}`);
  const participants = listParticipants(db, discussionId);
  if (participants.length === 0) throw new AppError(ErrorCode.VALIDATION, '讨论室无参与者');

  // 阶段七任务 7.3：parallel 模式为所有参与者各建一个发言 task（同轮并行）
  if (disc.mode === 'parallel') {
    const tx = db.transaction(() => {
      const prevTurns = listTurns(db, discussionId);
      const recentTurnsText = prevTurns.map((t) => {
        const agent = getAgent(db, t.speakerAgentId);
        return `[${agent.name}（${agent.role}）第${t.turnIndex + 1}轮] ${t.content ?? ''}`;
      });
      const createdTaskIds: string[] = [];
      // Review 修复（L-3）：预建任务数按剩余发言额度 clamp——若 maxTurns 不是 roundSize 整数倍，
      // 最后一轮只建额度内的任务数，避免本轮结束后仍有已预建发言任务成为孤儿（completeDiscussionTurn 会因
      // 讨论室已 concluding 抛错，任务被引擎标记 failed）。
      const remaining = disc.maxTurns - disc.turnCount;
      const toSpawn = Math.min(participants.length, Math.max(remaining, 0));
      for (let i = 0; i < toSpawn; i++) {
        const participant = participants[i]!;
        const task = createTask(db, {
          projectId: disc.projectId,
          assigneeAgentId: participant.agentId,
          title: `讨论：${disc.topic.slice(0, 30)}（第${disc.turnCount + 1}轮·并行）`,
          inputProtocol: {
            discussion: true,
            lightweight: true,
            discussionId,
            topic: disc.topic,
            context: disc.context,
            recentTurns: recentTurnsText.slice(-6),
            turnIndex: disc.turnCount,
            isYourTurn: true,
            instruction: `这是多人讨论室"${disc.topic}"。本轮所有参与者同时发言。请基于你的职责和专业就当前议题发表看法，回复写在 done 工具的 summary 字段里。简洁明确，聚焦议题。`,
          },
          priority: 1,
          isDiscussion: true,
        });
        createdTaskIds.push(task.id);
      }
      const now = nowIso();
      // 占位：current 指向第一个发言（语义标记"本轮进行中"）
      db.prepare('UPDATE discussion SET current_speaker_agent_id=?, current_turn_task_id=?, updated_at=? WHERE id=?')
        .run(participants[0]!.agentId, createdTaskIds[0]!, now, discussionId);
      return { discussion: getDiscussion(db, discussionId), turnTaskId: createdTaskIds[0]! };
    });
    return tx();
  }

  const speakerIdx = disc.turnCount % participants.length;
  const speaker = participants[speakerIdx];
  const tx = db.transaction(() => {
    const prevTurns = listTurns(db, discussionId);
    const recentTurnsText = prevTurns.map((t) => {
      const agent = getAgent(db, t.speakerAgentId);
      return `[${agent.name}（${agent.role}）第${t.turnIndex + 1}轮] ${t.content ?? ''}`;
    });
    const task = createTask(db, {
      projectId: disc.projectId,
      assigneeAgentId: speaker.agentId,
      title: `讨论：${disc.topic.slice(0, 30)}（第${disc.turnCount + 1}轮）`,
      inputProtocol: {
        discussion: true,
        lightweight: true, // 轻量化：发言只注入议题/前序发言/职责，跳过素材/技能/记忆等大段上下文
        discussionId,
        topic: disc.topic,
        context: disc.context,
        recentTurns: recentTurnsText.slice(-6), // 注入最近 6 条发言
        turnIndex: disc.turnCount,
        isYourTurn: true,
        instruction: `这是多人讨论室"${disc.topic}"。请基于你的职责和专业就当前议题发表看法，回复写在 done 工具的 summary 字段里。简洁明确，聚焦议题。若已达成共识可建议总结。`,
      },
      priority: 1, // 低优先级：正式 task 到达时排队中的讨论可被先执行
      isDiscussion: true, // 标记为讨论 task，让 coordinator 抢占逻辑生效
    });
    const now = nowIso();
    db.prepare('UPDATE discussion SET current_speaker_agent_id=?, current_turn_task_id=?, updated_at=? WHERE id=?')
      .run(speaker.agentId, task.id, now, discussionId);
    return { discussion: getDiscussion(db, discussionId), turnTaskId: task.id };
  });
  return tx();
}

/**
 * 发言完成（由引擎在 discussion task 完成时调用）：
 * 1. 记录发言内容到 discussion_turn
 * 2. 清空 current_speaker/current_turn_task
 * 3. turn_count++
 * 4. 若未达上限 → 自动启动下一轮（轮转到下一个参与者）
 * 5. 若已达上限 → 自动进入 concluding 状态（等待发起者 conclude 或自动用最后发言做纪要）
 */
export function completeDiscussionTurn(db: DB, discussionId: string, taskId: string, content: string): {
  discussion: Discussion;
  nextTurnTaskId: string | null;
  autoConcluded: boolean;
} {
  const disc = getDiscussion(db, discussionId);
  if (disc.state !== 'open') throw new AppError(ErrorCode.CONFLICT, `讨论室状态 ${disc.state}，无法记录发言`);
  const tx = db.transaction(() => {
    const now = nowIso();
    const turnId = shortId('dturn_');
    const turnIndex = disc.turnCount;
    // 发言者：优先取发言 task 的 assignee（parallel 模式 current_speaker 只是占位，
    // 第一个发言完成后即被清空，不能作为后续发言者身份）。
    const taskAssignee = db.prepare('SELECT assignee_agent_id FROM task WHERE id=?').get(taskId) as
      | { assignee_agent_id: string | null }
      | undefined;
    const speakerId = taskAssignee?.assignee_agent_id ?? disc.currentSpeakerAgentId ?? '';
    const isSynthesis = Boolean((getTaskInput(db, taskId) ?? {}).synthesis);
    db.prepare('INSERT INTO discussion_turn (id,discussion_id,task_id,speaker_agent_id,turn_index,content,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(turnId, discussionId, taskId, speakerId, turnIndex, content, now);
    // Review 修复：turn_count 只统计发言次数（synthesis 汇总不计数），
    // 保证 parallel 的 roundCompleted = turnCount % roundSize === 0 相位不漂移。
    db.prepare(`UPDATE discussion SET current_speaker_agent_id=NULL, current_turn_task_id=NULL,
      turn_count=turn_count+${isSynthesis ? 0 : 1}, updated_at=? WHERE id=?`)
      .run(now, discussionId);
    const updated = getDiscussion(db, discussionId);

    // 阶段七任务 7.3：parallel 模式——同轮并行发言 + moderator 汇总
    if (disc.mode === 'parallel') {
      const participants = listParticipants(db, discussionId);
      const roundSize = participants.length;
      // synthesis task 完成 → 本轮汇总结束，进入下一轮或 concluding
      if (isSynthesis) {
        if (updated.turnCount >= updated.maxTurns) {
          db.prepare("UPDATE discussion SET state='concluding', updated_at=? WHERE id=?").run(now, discussionId);
          return { discussion: getDiscussion(db, discussionId), nextTurnTaskId: null as string | null, autoConcluded: false };
        }
        const started = startDiscussion(db, discussionId);
        return { discussion: started.discussion, nextTurnTaskId: started.turnTaskId as string | null, autoConcluded: false };
      }
      // Review 修复（L-3）：先判发言上限再判本轮完成——原顺序在 turnCount 达 maxTurns 但本轮未凑齐
      // （maxTurns 不是 roundSize 整数倍）时提前 return 等待，配合下方 clamp 后讨论能准时收尾。
      if (updated.turnCount >= updated.maxTurns) {
        // 已达到发言上限：不再汇总，直接 concluding
        db.prepare("UPDATE discussion SET state='concluding', updated_at=? WHERE id=?").run(now, discussionId);
        return { discussion: getDiscussion(db, discussionId), nextTurnTaskId: null as string | null, autoConcluded: false };
      }
      // 普通发言完成：检查本轮是否全部完成（turn_count 是 roundSize 的整数倍）
      const roundCompleted = updated.turnCount % roundSize === 0;
      if (!roundCompleted) {
        // 本轮还有成员未发言：等待（不启动新发言）
        return { discussion: updated, nextTurnTaskId: null as string | null, autoConcluded: false };
      }
      // 本轮全部发言完成 → 创建 synthesis task（moderator 汇总）
      const moderator = participants.find((p) => p.role === 'moderator') ?? participants[0]!;
      const prevTurns = listTurns(db, discussionId);
      const recentTurnsText = prevTurns.map((t) => {
        const agent = getAgent(db, t.speakerAgentId);
        return `[${agent.name}（${agent.role}）第${t.turnIndex + 1}轮] ${t.content ?? ''}`;
      });
      const synthesisTask = createTask(db, {
        projectId: disc.projectId,
        assigneeAgentId: moderator.agentId,
        title: `讨论汇总：${disc.topic.slice(0, 30)}（第${Math.floor(updated.turnCount / roundSize)}轮）`,
        inputProtocol: {
          discussion: true,
          lightweight: true,
          discussionId,
          topic: disc.topic,
          context: disc.context,
          recentTurns: recentTurnsText.slice(-12),
          turnIndex: updated.turnCount,
          isYourTurn: true,
          synthesis: true,
          instruction: `你是讨论室"${disc.topic}"的 moderator。本轮参与者已全部发言，请汇总各方观点：提炼共识、分歧与下一步建议，回复写在 done 工具的 summary 字段里。`,
        },
        priority: 2,
        isDiscussion: true,
      });
      db.prepare('UPDATE discussion SET current_speaker_agent_id=?, current_turn_task_id=?, updated_at=? WHERE id=?')
        .run(moderator.agentId, synthesisTask.id, now, discussionId);
      return { discussion: getDiscussion(db, discussionId), nextTurnTaskId: synthesisTask.id as string | null, autoConcluded: false };
    }

    // sequential：达上限 → concluding；否则下一轮
    if (updated.turnCount >= updated.maxTurns) {
      db.prepare("UPDATE discussion SET state='concluding', updated_at=? WHERE id=?").run(now, discussionId);
      return { discussion: getDiscussion(db, discussionId), nextTurnTaskId: null as string | null, autoConcluded: false };
    }
    // 未达上限 → 自动启动下一轮
    const started = startDiscussion(db, discussionId);
    return { discussion: started.discussion, nextTurnTaskId: started.turnTaskId as string | null, autoConcluded: false };
  });
  return tx();
}

/** 读取 task inputProtocol（仅取 synthesis 标记用，避免引入 getTask 全量依赖）。 */
function getTaskInput(db: DB, taskId: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT input_protocol_json FROM task WHERE id=?').get(taskId) as { input_protocol_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.input_protocol_json ?? '{}') as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 总结讨论：写纪要 + 结论，按结论落地方式分发。
 * 可在讨论中途（state=open）或达上限后（state=concluding）调用。
 */
export function concludeDiscussion(db: DB, discussionId: string, input: {
  minutes: string;
  conclusion: DiscussionConclusion;
  /** 发起总结的 agent id（用于事件归属）。 */
  concludedByAgentId?: string;
  /** 无结果或需人工参与时为 true：写项目对话提示用户 + 不派实施 task，参与者分身释放回岗位。 */
  needsHuman?: boolean;
}): { discussion: Discussion; dispatchedTaskIds: string[]; memoryCandidateIds: string[] } {
  const disc = getDiscussion(db, discussionId);
  if (disc.state === 'concluded' || disc.state === 'closed') throw new AppError(ErrorCode.CONFLICT, '讨论已结束');
  const tx = db.transaction(() => {
    const now = nowIso();
    db.prepare("UPDATE discussion SET state='concluded', minutes=?, conclusion_json=?, updated_at=? WHERE id=?")
      .run(input.minutes, JSON.stringify(input.conclusion), now, discussionId);
    // 结论分发：派发实施 task（needsHuman=true 时不派 task，等人工确认）
    const dispatchedTaskIds: string[] = [];
    if (!input.needsHuman) {
      for (const action of input.conclusion.actions) {
        const task = createTask(db, {
          projectId: disc.projectId,
          assigneeAgentId: action.assigneeAgentId,
          title: action.title,
          inputProtocol: { ...action.payload, fromDiscussion: discussionId, discussionTopic: disc.topic },
          priority: 5,
        });
        dispatchedTaskIds.push(task.id);
      }
    }
    // P0-① 讨论记忆断链修复：memoryNotes 此前只落 conclusion_json（不可检索、不参与注入、无治理），
    // 现逐条转成 project 记忆候选——[讨论] 前缀溯源；confidence 0.8 与 LESSON 同权自动批准（project scope 门）。
    const memoryCandidateIds: string[] = [];
    const moderatorProfileId = input.concludedByAgentId
      ? (db.prepare('SELECT profile_id FROM agent_definition WHERE id=?').get(input.concludedByAgentId) as { profile_id: string } | undefined)?.profile_id
      : undefined;
    if (moderatorProfileId) {
      for (const note of input.conclusion.memoryNotes) {
        const candidate = createMemoryCandidate(db, {
          profileId: moderatorProfileId,
          scope: 'project',
          projectId: disc.projectId,
          content: `[讨论] ${disc.topic}：${note}`,
          author: 'agent',
          confidence: 0.8,
          canInfluence: true,
          allowAutoApprove: true,
        });
        memoryCandidateIds.push(candidate.id);
      }
    }
    // 写项目对话窗口（用户可见纪要）
    const humanNote = input.needsHuman ? '\n⚠️ 本讨论未能达成结论，需人工确认。参与者已回到各自岗位继续工作。' : '';
    const memoryNote = memoryCandidateIds.length ? `\n已沉淀 ${memoryCandidateIds.length} 条项目记忆` : '';
    postSystemMessage(db, {
      scopeKind: 'project',
      scopeId: disc.projectId,
      role: 'system',
      author: input.concludedByAgentId ?? 'system',
      content: `[讨论纪要] ${disc.topic}\n${input.minutes}\n结论要点：${input.conclusion.keyPoints.join('；')}${dispatchedTaskIds.length ? `\n已派发 ${dispatchedTaskIds.length} 个实施任务` : ''}${memoryNote}${humanNote}`,
    });
    void input.concludedByAgentId;
    return { discussion: getDiscussion(db, discussionId), dispatchedTaskIds, memoryCandidateIds };
  });
  const result = tx();
  // 讨论结束：释放参与者分身（非事务内，因 removeMirror 有活跃 task 检查）
  releaseDiscussionMirrors(db, discussionId);
  return result;
}

/**
 * 释放讨论参与者的分身 thread（讨论结束时调用）。
 * 只释放 idle 且无活跃 task 的分身；running 的留到下一轮。
 */
export function releaseDiscussionMirrors(db: DB, discussionId: string): string[] {
  const disc = getDiscussion(db, discussionId);
  const participants = listParticipants(db, discussionId);
  const released: string[] = [];
  for (const p of participants) {
    try {
      const primary = ensurePrimaryThread(db, disc.projectId, p.agentId);
      const mirrors = listMirrorsOfRoot(db, primary.id);
      for (const m of mirrors) {
        if (m.state === 'idle') {
          try { removeMirror(db, m.id); released.push(m.id); } catch { /* 有活跃 task 等下一轮 */ }
        }
      }
    } catch { /* 参与者已不存在 */ }
  }
  return released;
}

/** 关闭讨论（不再接受新发言；已 concluded 的可进一步 closed 归档）。 */
export function closeDiscussion(db: DB, discussionId: string): Discussion {
  const disc = getDiscussion(db, discussionId);
  if (disc.state === 'closed') return disc;
  const now = nowIso();
  db.prepare("UPDATE discussion SET state='closed', updated_at=? WHERE id=?").run(now, discussionId);
  releaseDiscussionMirrors(db, discussionId);
  return getDiscussion(db, discussionId);
}

/**
 * 蓝图组织批次4：用户主动发起探讨。
 *
 * 机制与智能体发起完全同构（分身参会、轮转发言、纪要回写项目群聊）；
 * 场景固定 brainstorm（探索性议题，任何人可发起，结论落为建议 task）。
 * 选择面规则：一次性执行体（系统隐形岗、hidden 任职的蜂群工蜂/辩手）不可被选为参与者——
 * 数量会爆炸的瞬态执行体不进用户的选择面，它们只受直属调度控制。
 */
export function startUserDiscussion(db: DB, input: {
  projectId: string;
  topic: string;
  participantAgentIds: string[];
  context?: Record<string, unknown>;
  maxTurns?: number;
}): { discussion: Discussion; turnTaskId: string } {
  const project = getProject(db, input.projectId);
  for (const id of input.participantAgentIds) {
    const agent = getAgent(db, id);
    if (agent.companyId !== project.companyId) {
      throw new AppError(ErrorCode.UNAUTHORIZED, `员工 ${id} 不属于项目所在公司`);
    }
    // B5 双闸白名单：中央六岗（常驻群聊可被 @）放行；其余系统隐形岗仍拒（蜂群工蜂/辩手只受直属调度）
    if (agent.isSystem && !(CENTRAL_STAFF_ROLES as readonly string[]).includes(agent.role)) {
      throw new AppError(ErrorCode.VALIDATION, `系统隐形岗（${agent.name}）不可参与探讨`);
    }
    const employment = db.prepare('SELECT hidden FROM company_employee WHERE legacy_agent_id=?').get(id) as
      | { hidden: number }
      | undefined;
    if (employment?.hidden === 1 && !(CENTRAL_STAFF_ROLES as readonly string[]).includes(agent.role)) {
      throw new AppError(ErrorCode.VALIDATION, `一次性执行体（${agent.name}）不可参与探讨：蜂群工蜂/辩手不进选择面，由其直属调度控制`);
    }
  }
  const discussion = createDiscussion(db, {
    projectId: input.projectId,
    topic: input.topic,
    participantAgentIds: input.participantAgentIds,
    context: { ...(input.context ?? {}), userInitiated: true },
    maxTurns: input.maxTurns,
    scenario: 'brainstorm',
  });
  const started = startDiscussion(db, discussion.id);
  // 开场播报到项目群聊：用户能看到探讨已开始、谁在参与（纪要结束时也会回写）。
  postSystemMessage(db, {
    scopeKind: 'project',
    scopeId: input.projectId,
    role: 'system',
    author: 'user',
    content: `[探讨开始] ${input.topic}\n参与者：${input.participantAgentIds
      .map((id) => { try { return getAgent(db, id).name; } catch { return id; } })
      .join('、')}`,
  });
  return started;
}
