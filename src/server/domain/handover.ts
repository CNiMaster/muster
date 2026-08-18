/**
 * 离职交接工作流领域层（批次 C）。
 *
 * 按人整体交接（跨所有项目）：工作履历、经验教训、进行中工作、待办、注意事项。
 *
 * 四阶段：
 *   drafting（系统 + 离职员工整理产物清单 + 交接记录）
 *   → awaiting（用户选接手人）
 *   → receiving（接手人逐项确认，产物 owner 指针转移）
 *   → completed（离职生效，产物留项目，记录归档）
 *
 * 连环交接：previous_handover_id 链表可追溯，但 owner 始终单一指针（不叠加）。
 *
 * 详见 docs/superpowers/specs/2026-08-10-temp-worker-and-handover-design.md 第四节。
 */
import { rmSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { getAgent, deleteAgent } from './agent';
import { getWorkbench } from './workbench';
import { getAgentHomePath } from './agent-home';
import { transferAllArtifactsOfOwner } from './artifact';
import { listAgentAuditLog } from './artifact-audit';

export type HandoverState = 'drafting' | 'awaiting' | 'receiving' | 'completed' | 'cancelled';

export interface HandoverRecord {
  id: string;
  departingEmployeeId: string;
  departingProfileId: string;
  receiverEmployeeId: string | null;
  previousHandoverId: string | null;
  state: HandoverState;
  handoverNote: string | null;
  workHistory: Array<{ projectId: string; role: string; period: string; summary: string }>;
  lessons: string[];
  pendingWork: Array<{ title: string; detail: string }>;
  artifactInventory: Array<{ projectId: string; items: Array<{ path: string; note: string; transferred: boolean }> }>;
  receiverAcknowledgement: string | null;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
}

interface HandoverRow {
  id: string;
  departing_employee_id: string;
  departing_profile_id: string;
  receiver_employee_id: string | null;
  previous_handover_id: string | null;
  state: string;
  handover_note: string | null;
  work_history_json: string;
  lessons_json: string;
  pending_work_json: string;
  artifact_inventory_json: string;
  receiver_acknowledgement: string | null;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
}

function fromRow(_db: DB, r: HandoverRow): HandoverRecord {
  return {
    id: r.id,
    departingEmployeeId: r.departing_employee_id,
    departingProfileId: r.departing_profile_id,
    receiverEmployeeId: r.receiver_employee_id,
    previousHandoverId: r.previous_handover_id,
    state: r.state as HandoverState,
    handoverNote: r.handover_note,
    workHistory: JSON.parse(r.work_history_json ?? '[]'),
    lessons: JSON.parse(r.lessons_json ?? '[]'),
    pendingWork: JSON.parse(r.pending_work_json ?? '[]'),
    artifactInventory: JSON.parse(r.artifact_inventory_json ?? '[]'),
    receiverAcknowledgement: r.receiver_acknowledgement,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    updatedAt: r.updated_at,
  };
}

const ALLOWED_TRANSITIONS: Record<HandoverState, HandoverState[]> = {
  drafting: ['awaiting', 'cancelled'],
  awaiting: ['receiving', 'cancelled'],
  receiving: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

function assertTransition(from: HandoverState, to: HandoverState): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new AppError(ErrorCode.VALIDATION, `非法交接迁移：${from} → ${to}`);
  }
}

/**
 * 自动生成离职员工的产物清单（按项目分组）。
 * 查询该员工在所有项目里拥有的 artifact。
 */
function buildArtifactInventory(db: DB, agentId: string): HandoverRecord['artifactInventory'] {
  const rows = db
    .prepare(
      `SELECT project_id, path FROM artifact WHERE owner_agent_id = ? ORDER BY project_id, path`,
    )
    .all(agentId) as { project_id: string; path: string }[];
  const byProject = new Map<string, Array<{ path: string; note: string; transferred: boolean }>>();
  for (const r of rows) {
    const arr = byProject.get(r.project_id) ?? [];
    arr.push({ path: r.path, note: '', transferred: false });
    byProject.set(r.project_id, arr);
  }
  return Array.from(byProject.entries()).map(([projectId, items]) => ({ projectId, items }));
}

/**
 * 阶段 1：创建交接记录（drafting）。
 * 系统自动汇总产物清单 + 审计日志。离职员工可补充交接记录、经验教训、待办。
 */
export function createHandover(db: DB, input: { departingEmployeeId: string }): HandoverRecord {
  getAgent(db, input.departingEmployeeId); // 校验离职员工存在
  // 检查是否已有未完成交接
  const existing = db
    .prepare(
      `SELECT id FROM handover_record WHERE departing_employee_id=? AND state IN ('drafting','awaiting','receiving')`,
    )
    .get(input.departingEmployeeId) as { id: string } | undefined;
  if (existing) {
    throw new AppError(ErrorCode.CONFLICT, `已有未完成交接记录：${existing.id}`);
  }
  const id = shortId('ho_');
  const now = nowIso();
  const inventory = buildArtifactInventory(db, input.departingEmployeeId);
  db.prepare(
    `INSERT INTO handover_record
      (id, departing_employee_id, departing_profile_id, receiver_employee_id,
       previous_handover_id, state, handover_note, work_history_json, lessons_json,
       pending_work_json, artifact_inventory_json, receiver_acknowledgement, created_at, completed_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, 'drafting', NULL, '[]', '[]', '[]', ?, NULL, ?, NULL, ?)`,
  ).run(id, input.departingEmployeeId, getAgent(db, input.departingEmployeeId).profileId, JSON.stringify(inventory), now, now);
  return getHandover(db, id);
}

export function getHandover(db: DB, id: string): HandoverRecord {
  const row = db.prepare('SELECT * FROM handover_record WHERE id=?').get(id) as HandoverRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `交接记录 ${id} 不存在`);
  return fromRow(db, row);
}

/** 列出公司的交接记录。 */
export function listHandovers(db: DB): HandoverRecord[] {
  const rows = db
    .prepare('SELECT * FROM handover_record ORDER BY updated_at DESC')
    .all() as HandoverRow[];
  return rows.map((row) => fromRow(db, row));
}

/**
 * 阶段 1 补充：离职员工/系统更新交接内容（交接记录、经验教训、待办）。
 */
export function updateHandoverContent(
  db: DB,
  id: string,
  input: {
    handoverNote?: string;
    workHistory?: HandoverRecord['workHistory'];
    lessons?: string[];
    pendingWork?: HandoverRecord['pendingWork'];
  },
): HandoverRecord {
  const cur = getHandover(db, id);
  if (cur.state !== 'drafting') {
    throw new AppError(ErrorCode.VALIDATION, `交接记录 ${id} 状态 ${cur.state}，仅 drafting 可更新内容`);
  }
  const sets: string[] = ['updated_at=?'];
  const params: unknown[] = [nowIso()];
  if (input.handoverNote !== undefined) {
    sets.push('handover_note=?');
    params.push(input.handoverNote);
  }
  if (input.workHistory !== undefined) {
    sets.push('work_history_json=?');
    params.push(JSON.stringify(input.workHistory));
  }
  if (input.lessons !== undefined) {
    sets.push('lessons_json=?');
    params.push(JSON.stringify(input.lessons));
  }
  if (input.pendingWork !== undefined) {
    sets.push('pending_work_json=?');
    params.push(JSON.stringify(input.pendingWork));
  }
  params.push(id);
  db.prepare(`UPDATE handover_record SET ${sets.join(', ')} WHERE id=?`).run(...params);
  return getHandover(db, id);
}

/**
 * 阶段 2：用户指定接手人（drafting/awaiting → awaiting）。
 */
export function assignReceiver(db: DB, id: string, receiverEmployeeId: string): HandoverRecord {
  const cur = getHandover(db, id);
  if (cur.state === 'drafting') {
    assertTransition(cur.state, 'awaiting');
  } else if (cur.state !== 'awaiting') {
    throw new AppError(ErrorCode.VALIDATION, `交接记录 ${id} 状态 ${cur.state}，不可指定接手人`);
  }
  // 校验接手人存在（同工作台语义下无需再比对公司归属）
  const receiver = getAgent(db, receiverEmployeeId);
  if (receiverEmployeeId === cur.departingEmployeeId) {
    throw new AppError(ErrorCode.VALIDATION, '不能交接给自己');
  }
  db.prepare(
    `UPDATE handover_record SET receiver_employee_id=?, state='awaiting', updated_at=? WHERE id=?`,
  ).run(receiverEmployeeId, nowIso(), id);
  return getHandover(db, id);
}

/**
 * 阶段 3：接手人开始接收（awaiting → receiving）。
 */
export function startReceiving(db: DB, id: string): HandoverRecord {
  const cur = getHandover(db, id);
  assertTransition(cur.state, 'receiving');
  db.prepare(`UPDATE handover_record SET state='receiving', updated_at=? WHERE id=?`).run(nowIso(), id);
  return getHandover(db, id);
}

/**
 * 阶段 3 核心：转移该员工在某项目的全部产物所有权到接手人（单一指针，不叠加）。
 * 转移后产物留在项目原路径（检索不遗漏），owner 指针指向接手人。
 */
export function transferArtifactsInHandover(db: DB, id: string, projectId: string): { transferred: number } {
  const cur = getHandover(db, id);
  if (cur.state !== 'receiving') {
    throw new AppError(ErrorCode.VALIDATION, `交接记录 ${id} 状态 ${cur.state}，仅 receiving 可转移产物`);
  }
  if (!cur.receiverEmployeeId) {
    throw new AppError(ErrorCode.VALIDATION, '未指定接手人');
  }
  const count = transferAllArtifactsOfOwner(db, projectId, cur.departingEmployeeId, cur.receiverEmployeeId);
  // 更新清单 transferred 标记
  const inventory = cur.artifactInventory.map((inv) =>
    inv.projectId === projectId
      ? { ...inv, items: inv.items.map((it) => ({ ...it, transferred: true })) }
      : inv,
  );
  db.prepare('UPDATE handover_record SET artifact_inventory_json=?, updated_at=? WHERE id=?').run(
    JSON.stringify(inventory),
    nowIso(),
    id,
  );
  return { transferred: count };
}

/**
 * 阶段 4：交接完成（receiving → completed）。
 * 执行离职：deleteAgent（删任职），正式员工 profile+Home 保留。
 */
export function completeHandover(db: DB, id: string, opts?: { musterHome?: string }): HandoverRecord {
  const cur = getHandover(db, id);
  // 先校验接手人（在状态机校验之前，给用户更准确的错误信息）
  if (!cur.receiverEmployeeId) {
    throw new AppError(ErrorCode.VALIDATION, '未指定接手人，不可完成交接');
  }
  assertTransition(cur.state, 'completed');
  const now = nowIso();
  // 执行离职前：若离职员工是公司/项目的 first_agent，转移给接手人或清除（防 FK 冲突）
  let companyId = 'default';
  db.transaction(() => {
    const company = db.prepare('SELECT id, first_agent_id FROM workbench LIMIT 1').get() as { id: string; first_agent_id: string | null } | undefined;
    if (company) {
      companyId = company.id;
      if (company.first_agent_id === cur.departingEmployeeId) {
        db.prepare('UPDATE workbench SET first_agent_id=? WHERE id=?').run(cur.receiverEmployeeId, company.id);
      }
    }
    // 项目的 first_agent_id 同理（ON DELETE SET NULL 会自动处理，但显式转移更优）
    db.prepare('UPDATE project SET first_agent_id=? WHERE first_agent_id=?').run(
      cur.receiverEmployeeId, cur.departingEmployeeId,
    );
    db.prepare('DELETE FROM agent_definition WHERE id=?').run(cur.departingEmployeeId);
  })();
  // 归档该工作台在 Agent Home 的记忆分区
  archiveCompanyMemoryPartition(cur.departingProfileId, companyId, opts?.musterHome);
  db.prepare(
    `UPDATE handover_record SET state='completed', completed_at=?, updated_at=? WHERE id=?`,
  ).run(now, now, id);
  return getHandover(db, id);
}

/** 取消交接。 */
export function cancelHandover(db: DB, id: string): HandoverRecord {
  const cur = getHandover(db, id);
  assertTransition(cur.state, 'cancelled');
  db.prepare(`UPDATE handover_record SET state='cancelled', updated_at=? WHERE id=?`).run(nowIso(), id);
  return getHandover(db, id);
}

/**
 * 正式员工离职（带交接）。
 * 封装：创建交接 → （用户在 UI 走完四阶段）→ completeHandover 删任职。
 * 本函数仅创建交接记录入口，实际完成由 completeHandover 触发。
 */
export function offboardEmployee(db: DB, employeeId: string): HandoverRecord {
  return createHandover(db, { departingEmployeeId: employeeId });
}

/** 归档 Agent Home 中某公司的记忆分区到 archive/ 子目录。 */
function archiveCompanyMemoryPartition(profileId: string, companyId: string, musterHome?: string): void {
  const home = getAgentHomePath(profileId, musterHome);
  const companyDir = path.join(home, 'companies', companyId);
  const archiveDir = path.join(home, 'archive');
  const dest = path.join(archiveDir, `${companyId}-${new Date().toISOString().slice(0, 10)}`);
  try {
    if (!existsSync(companyDir)) return;
    mkdirSync(archiveDir, { recursive: true });
    renameSync(companyDir, dest);
  } catch {
    // 目录不存在或归档失败不阻塞交接完成
  }
}
