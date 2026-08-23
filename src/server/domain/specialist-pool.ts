/**
 * 项目专家池（组织模型批次二，2026-08-19 定案）：专家 = 项目级常驻执行体，非固定员工。
 *
 * 生命周期（用户模型）：
 * - 蜂群反复需要同一专长 → 需求计数（agent_id 为空的计数行）；第 2 次起落成常驻项目专家（临时蜂退役）。
 * - 人事（HR 岗）staffingPlan 直接创建项目专家。
 * - 只加不减：任务结束不回收（无自动 dismiss）；dismiss 是用户手动下岗，仅改状态不删行。
 * - 阶梯：project（项目专家，本项目可见）→ use_count 达阈值自动晋升 staff（常驻专家，跨项目可借）。
 *
 * 与蜂群的关系：materializeSwarm 的 persona 蜂优先走 acquireSpecialistForPersona——
 * 命中常驻专家则由它执行（跨任务延续记忆与线程）；未命中才放一次性临时蜂。
 */
import type { DB } from '../db/client';
import { nowIso, shortId } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';
import { createAgent, getAgent } from './agent';
import { getProject } from './project';
import { getPersona } from './persona-library';
import { appendTaskEvent } from './task-event';
import type { StaffingPlan } from '../../shared/types';

export type SpecialistTier = 'project' | 'staff';
export type SpecialistStatus = 'active' | 'dismissed';

export interface SpecialistPoolEntry {
  id: string;
  projectId: string;
  agentId: string | null;
  personaId: string | null;
  specialty: string;
  tier: SpecialistTier;
  status: SpecialistStatus;
  useCount: number;
  createdVia: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string; project_id: string; agent_id: string | null; persona_id: string | null;
  specialty: string; tier: SpecialistTier; status: SpecialistStatus;
  use_count: number; created_via: string; created_at: string; updated_at: string;
}

const fromRow = (r: Row): SpecialistPoolEntry => ({
  id: r.id, projectId: r.project_id, agentId: r.agent_id, personaId: r.persona_id,
  specialty: r.specialty, tier: r.tier, status: r.status, useCount: r.use_count,
  createdVia: r.created_via, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** 同一专长第二次被需要时，临时蜂升级为常驻项目专家（第 1 次只记需求）。 */
const PROMOTE_TO_AGENT_AT_USE = 2;
/** 常驻专家（跨项目可借）的使用次数门槛。 */
const PROMOTE_TO_STAFF_AT_USE = 5;

export function listProjectSpecialists(db: DB, projectId: string, opts: { activeOnly?: boolean } = {}): SpecialistPoolEntry[] {
  const rows = (opts.activeOnly === false
    ? db.prepare('SELECT * FROM specialist_pool WHERE project_id=? ORDER BY created_at')
    : db.prepare("SELECT * FROM specialist_pool WHERE project_id=? AND status='active' ORDER BY created_at")
  ).all(projectId) as Row[];
  return rows.map(fromRow);
}

/** 全局常驻专家（跨项目可借清单，养蜂人/人事的上下文注入用）。 */
export function listStaffSpecialists(db: DB, excludeProjectId?: string): SpecialistPoolEntry[] {
  const rows = db.prepare(
    "SELECT * FROM specialist_pool WHERE tier='staff' AND status='active' AND agent_id IS NOT NULL ORDER BY use_count DESC",
  ).all() as Row[];
  return rows.map(fromRow).filter((e) => e.projectId !== excludeProjectId);
}

/** 纯查询：项目里是否有穿戴该人设的常驻专家（不记需求计数；蓝图路由等非蜂群通道用）。 */
export function findActiveSpecialistAgent(db: DB, projectId: string, personaId: string): string | null {
  const row = db.prepare(
    "SELECT agent_id AS a FROM specialist_pool WHERE project_id=? AND persona_id=? AND status='active' AND agent_id IS NOT NULL LIMIT 1",
  ).get(projectId, personaId) as { a: string } | undefined;
  return row?.a ?? null;
}

function getEntry(db: DB, id: string): SpecialistPoolEntry {
  const row = db.prepare('SELECT * FROM specialist_pool WHERE id=?').get(id) as Row | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `专家池条目不存在: ${id}`);
  return fromRow(row);
}

/** 创建常驻项目专家（可见、非一次性、不随蜂群回收）。 */
export function createProjectSpecialist(db: DB, input: {
  projectId: string;
  specialty: string;
  personaId?: string | null;
  brief?: string;
  via: 'swarm' | 'hr' | 'manual';
}): SpecialistPoolEntry {
  const project = getProject(db, input.projectId);
  const persona = input.personaId ? (getPersona(input.personaId) ?? null) : null;
  const name = persona?.name ?? `专家·${input.specialty.slice(0, 10)}`;
  const agent = createAgent(db, {
    name,
    role: 'specialist',
    responsibilities: `项目专家（${input.specialty}）${input.brief ? `：${input.brief}` : ''}`,
    systemPrompt: persona ? `你是项目专家「${persona.name}」，以该领域的专业标准完成分派的工作。` : '',
    contactAllow: [],
    // 专家在任务进行中被组建（蜂群中途/人事兑现），与临时工同走 tempRecruit 豁免 org lock；
    // 但不标 temp 任职——专家是常驻项目成员，不参与临时工的一次性回收链。
    tempRecruit: true,
  });
  const id = shortId('spc_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO specialist_pool (id, project_id, agent_id, persona_id, specialty, tier, status, use_count, created_via, created_at, updated_at)
     VALUES (?,?,?,?,?, 'project', 'active', 0, ?, ?, ?)`,
  ).run(id, project.id, agent.id, input.personaId ?? null, input.specialty, input.via, now, now);
  return getEntry(db, id);
}

function maybePromoteToStaff(db: DB, entry: SpecialistPoolEntry): SpecialistPoolEntry {
  if (entry.tier === 'project' && entry.status === 'active' && entry.agentId && entry.useCount >= PROMOTE_TO_STAFF_AT_USE) {
    db.prepare("UPDATE specialist_pool SET tier='staff', updated_at=? WHERE id=?").run(nowIso(), entry.id);
    return getEntry(db, entry.id);
  }
  return entry;
}

/** 公开取条目（盘点处置等外部域用）。 */
export function getSpecialistEntry(db: DB, id: string): SpecialistPoolEntry {
  return getEntry(db, id);
}

/** 强制晋升 staff（盘点处置 promote 动作；幂等——已是 staff 直接返回）。 */
export function forcePromoteToStaff(db: DB, id: string): SpecialistPoolEntry {
  const entry = getEntry(db, id);
  if (entry.tier !== 'staff') {
    db.prepare("UPDATE specialist_pool SET tier='staff', updated_at=? WHERE id=?").run(nowIso(), id);
  }
  return getEntry(db, id);
}

/**
 * 跨项目借调 staff 专家（批次 J1）：留痕 specialist_borrow + use 记账。
 * 归还=记账非状态迁移（专家默认不排队不锁定）；借调不虚增本项目需求计数。
 */
export function borrowStaffSpecialist(db: DB, input: { specialistId: string; toProjectId: string; taskId?: string }): { agentId: string; borrowId: string } {
  const entry = getEntry(db, input.specialistId);
  if (entry.tier !== 'staff' || entry.status !== 'active' || !entry.agentId) {
    throw new AppError(ErrorCode.CONFLICT, '只有在册常驻（staff）专家可被跨项目借调');
  }
  if (entry.projectId === input.toProjectId) {
    throw new AppError(ErrorCode.VALIDATION, '同项目使用走 recordSpecialistUse，不算借调');
  }
  const now = nowIso();
  const borrowId = shortId('sbr_');
  db.transaction(() => {
    db.prepare(
      `INSERT INTO specialist_borrow (id, from_project_id, to_project_id, specialist_id, agent_id, task_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(borrowId, entry.projectId, input.toProjectId, entry.id, entry.agentId, input.taskId ?? null, now);
    db.prepare('UPDATE specialist_pool SET use_count=use_count+1, updated_at=? WHERE id=?').run(now, entry.id);
  })();
  return { agentId: entry.agentId, borrowId };
}

/**
 * 借调候选匹配（蜂群 J1）：personaId 精确优先，specialty 关键词模糊兜底；
 * 排除本项目（本项目有自己的池逻辑）与 dismissed。
 */
export function findStaffBorrowCandidate(db: DB, toProjectId: string, personaId: string | null, specialty: string): SpecialistPoolEntry | null {
  const rows = db.prepare(
    "SELECT * FROM specialist_pool WHERE tier='staff' AND status='active' AND agent_id IS NOT NULL ORDER BY use_count DESC LIMIT 100",
  ).all() as Row[];
  const entries = rows.map(fromRow).filter((e) => e.projectId !== toProjectId);
  const byPersona = personaId ? entries.find((e) => e.personaId === personaId) : undefined;
  if (byPersona) return byPersona;
  const tokens = specialty.split(/[\s/·、,，]+/).filter((t) => t.length >= 2);
  return entries.find((e) => tokens.some((t) => e.specialty.includes(t))) ?? null;
}

/**
 * 蜂群按人设取用专家（materializeSwarm 的 persona 蜂入口）：
 * - 已有常驻专家（agent_id 落位）→ 直接复用（use_count++，达阈值晋升 staff）。
 * - 只有需求计数行（agent_id 空）→ 计数 +1；达 PROMOTE_TO_AGENT_AT_USE 时落成常驻专家并返回。
 * - 无行 → 记第一条需求计数，返回 null（调用方本次仍走一次性临时蜂）。
 */
export function acquireSpecialistForPersona(db: DB, projectId: string, personaId: string, specialty: string): { agentId: string; created: boolean } | null {
  getProject(db, projectId);
  const row = db.prepare(
    "SELECT * FROM specialist_pool WHERE project_id=? AND persona_id=? AND status='active' ORDER BY created_at LIMIT 1",
  ).get(projectId, personaId) as Row | undefined;
  const now = nowIso();
  if (row?.agent_id) {
    db.prepare('UPDATE specialist_pool SET use_count=use_count+1, updated_at=? WHERE id=?').run(now, row.id);
    maybePromoteToStaff(db, getEntry(db, row.id));
    return { agentId: row.agent_id, created: false };
  }
  if (row) {
    const nextUse = row.use_count + 1;
    if (nextUse >= PROMOTE_TO_AGENT_AT_USE) {
      // 需求已证实：临时蜂退役，落成常驻项目专家
      const created = createProjectSpecialist(db, {
        projectId, specialty: row.specialty || specialty, personaId, via: 'swarm',
      });
      if (!created.agentId) return null; // 理论不可达（createProjectSpecialist 必落 agent）
      db.prepare('UPDATE specialist_pool SET agent_id=?, use_count=?, updated_at=? WHERE id=?').run(created.agentId, nextUse, now, row.id);
      return { agentId: created.agentId, created: true };
    }
    db.prepare('UPDATE specialist_pool SET use_count=?, updated_at=? WHERE id=?').run(nextUse, now, row.id);
    return null;
  }
  db.prepare(
    `INSERT INTO specialist_pool (id, project_id, agent_id, persona_id, specialty, tier, status, use_count, created_via, created_at, updated_at)
     VALUES (?,?,NULL,?,?, 'project', 'active', 1, 'swarm', ?, ?)`,
  ).run(shortId('spc_'), projectId, personaId, specialty, now, now);
  return null;
}

/** 人事 staffingPlan 兑现：逐位建项目专家，留痕到来源任务。 */
export function materializeStaffingPlan(db: DB, sourceTaskId: string, plan: StaffingPlan): { created: SpecialistPoolEntry[] } {
  const created: SpecialistPoolEntry[] = [];
  for (const item of plan.specialists.slice(0, 8)) {
    const entry = createProjectSpecialist(db, {
      projectId: (db.prepare('SELECT project_id AS p FROM task WHERE id=?').get(sourceTaskId) as { p: string }).p,
      specialty: item.specialty,
      personaId: item.personaId ?? null,
      brief: item.brief,
      via: 'hr',
    });
    created.push(entry);
    appendTaskEvent(db, sourceTaskId, 'specialist_created', {
      specialistId: entry.id,
      agentId: entry.agentId,
      specialty: entry.specialty,
      personaId: entry.personaId,
      via: 'hr',
    });
  }
  return { created };
}

/** 专家使用记账（蜂任务之外的手动派遣也可调用）。 */
export function recordSpecialistUse(db: DB, id: string): SpecialistPoolEntry {
  const entry = getEntry(db, id);
  db.prepare('UPDATE specialist_pool SET use_count=use_count+1, updated_at=? WHERE id=?').run(nowIso(), id);
  return maybePromoteToStaff(db, getEntry(db, id));
}

/** 手动下岗（只加不减的例外出口：仅改状态，行与 agent 保留审计）。 */
export function dismissSpecialist(db: DB, id: string): SpecialistPoolEntry {
  const entry = getEntry(db, id);
  db.prepare("UPDATE specialist_pool SET status='dismissed', updated_at=? WHERE id=?").run(nowIso(), id);
  return getEntry(db, id);
}

/** 花名册名（养蜂人/人事上下文清单用）。 */
export function specialistLabel(db: DB, entry: SpecialistPoolEntry): string {
  if (!entry.agentId) return entry.specialty;
  try {
    return getAgent(db, entry.agentId).name;
  } catch {
    return entry.specialty;
  }
}
