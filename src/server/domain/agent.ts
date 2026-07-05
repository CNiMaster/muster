/**
 * Agent Definition 领域：员工 CRUD + 组织配置锁校验。
 *
 * 上班期间（公司非 off）禁止增删改员工。
 * 角色冲突（如同一员工不能同时是 lead + writer）由调用方在项目层校验。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getCompany, isOrgLocked } from './company';
import { assertDepartmentInCompany } from './department';

export interface AgentDefinition {
  id: string;
  companyId: string;
  departmentId: string | null;
  name: string;
  role: string;
  responsibilities: string;
  systemPrompt: string;
  skills: string[];
  tools: string[];
  permissions: Record<string, unknown>;
  contactAllow: string[];
  canDispatch: boolean;
  executor: Record<string, unknown>;
  isInspector: boolean;
  availabilityState: 'online' | 'draining' | 'off';
  createdAt: string;
  updatedAt: string;
}

interface AgentRow {
  id: string;
  company_id: string;
  department_id: string | null;
  name: string;
  role: string;
  responsibilities: string;
  system_prompt: string;
  skills_json: string;
  tools_json: string;
  permissions_json: string;
  contact_allow_json: string;
  can_dispatch: number;
  executor_json: string;
  is_inspector: number;
  availability_state: 'online' | 'draining' | 'off';
  created_at: string;
  updated_at: string;
}

function fromRow(r: AgentRow): AgentDefinition {
  return {
    id: r.id,
    companyId: r.company_id,
    departmentId: r.department_id,
    name: r.name,
    role: r.role,
    responsibilities: r.responsibilities,
    systemPrompt: r.system_prompt,
    skills: JSON.parse(r.skills_json ?? '[]'),
    tools: JSON.parse(r.tools_json ?? '[]'),
    permissions: JSON.parse(r.permissions_json ?? '{}'),
    contactAllow: JSON.parse(r.contact_allow_json ?? '[]'),
    canDispatch: r.can_dispatch === 1,
    executor: JSON.parse(r.executor_json ?? '{}'),
    isInspector: r.is_inspector === 1,
    availabilityState: r.availability_state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateAgentInput {
  companyId: string;
  departmentId?: string;
  name: string;
  role: string;
  responsibilities?: string;
  systemPrompt?: string;
  skills?: string[];
  tools?: string[];
  permissions?: Record<string, unknown>;
  contactAllow?: string[];
  canDispatch?: boolean;
  executor?: Record<string, unknown>;
  isInspector?: boolean;
}

function assertUnlocked(db: DB, companyId: string): void {
  if (isOrgLocked(db, companyId)) {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '上班期间不能修改员工配置');
  }
}

function assertContactAllow(db: DB, companyId: string, contactAllow: string[]): void {
  if (contactAllow.length === 0) return;
  const placeholders = contactAllow.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id FROM agent_definition WHERE company_id = ? AND id IN (${placeholders})`,
  ).all(companyId, ...contactAllow) as Array<{ id: string }>;
  const valid = new Set(rows.map((row) => row.id));
  const invalid = contactAllow.filter((id) => !valid.has(id));
  if (invalid.length > 0) {
    throw new AppError(ErrorCode.VALIDATION, `联系人必须是本公司员工：${invalid.join(', ')}`);
  }
}

export function createAgent(db: DB, input: CreateAgentInput): AgentDefinition {
  getCompany(db, input.companyId); // 校验存在
  assertUnlocked(db, input.companyId);
  assertDepartmentInCompany(db, input.companyId, input.departmentId ?? null);
  assertContactAllow(db, input.companyId, input.contactAllow ?? []);

  const id = shortId('ag_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO agent_definition
      (id, company_id, department_id, name, role, responsibilities, system_prompt,
       skills_json, tools_json, permissions_json, contact_allow_json, can_dispatch,
       executor_json, is_inspector, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, input.companyId, input.departmentId ?? null, input.name, input.role,
    input.responsibilities ?? '', input.systemPrompt ?? '',
    JSON.stringify(input.skills ?? []), JSON.stringify(input.tools ?? []),
    JSON.stringify(input.permissions ?? {}), JSON.stringify(input.contactAllow ?? []),
    input.canDispatch === false ? 0 : 1,
    JSON.stringify(input.executor ?? {}),
    input.isInspector ? 1 : 0,
    now, now,
  );
  return getAgent(db, id);
}

export function getAgent(db: DB, id: string): AgentDefinition {
  const row = db.prepare('SELECT * FROM agent_definition WHERE id = ?').get(id) as AgentRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `agent ${id} not found`);
  return fromRow(row);
}

export function listAgents(db: DB, companyId: string): AgentDefinition[] {
  const rows = db.prepare('SELECT * FROM agent_definition WHERE company_id = ? ORDER BY created_at').all(companyId) as AgentRow[];
  return rows.map(fromRow);
}

export function updateAgent(
  db: DB,
  id: string,
  patch: Partial<Omit<AgentDefinition, 'id' | 'companyId' | 'createdAt' | 'availabilityState'>>,
): AgentDefinition {
  const cur = getAgent(db, id);
  assertUnlocked(db, cur.companyId);
  const next: AgentDefinition = {
    ...cur,
    ...patch,
    updatedAt: nowIso(),
  };
  assertDepartmentInCompany(db, cur.companyId, next.departmentId);
  assertContactAllow(db, cur.companyId, next.contactAllow);
  db.prepare(
    `UPDATE agent_definition SET
      department_id=?, name=?, role=?, responsibilities=?, system_prompt=?,
      skills_json=?, tools_json=?, permissions_json=?, contact_allow_json=?,
      can_dispatch=?, executor_json=?, is_inspector=?, updated_at=?
     WHERE id=?`,
  ).run(
    next.departmentId, next.name, next.role, next.responsibilities, next.systemPrompt,
    JSON.stringify(next.skills), JSON.stringify(next.tools),
    JSON.stringify(next.permissions), JSON.stringify(next.contactAllow),
    next.canDispatch ? 1 : 0, JSON.stringify(next.executor), next.isInspector ? 1 : 0,
    next.updatedAt, id,
  );
  return getAgent(db, id);
}

export function deleteAgent(db: DB, id: string): void {
  const cur = getAgent(db, id);
  assertUnlocked(db, cur.companyId);
  if (cur.isInspector) {
    throw new AppError(ErrorCode.CONFLICT, '监察员工是系统稳定性岗位，不能删除；可以修改配置');
  }
  db.prepare('DELETE FROM agent_definition WHERE id=?').run(id);
}

/** 员工独立上班；不改变公司组织配置。 */
export function clockInAgent(db: DB, id: string): AgentDefinition {
  getAgent(db, id);
  db.prepare("UPDATE agent_definition SET availability_state='online', updated_at=? WHERE id=?").run(nowIso(), id);
  return getAgent(db, id);
}

/** 员工独立下班；有正在执行的 Task 时先排空。 */
export function clockOutAgent(db: DB, id: string): AgentDefinition {
  getAgent(db, id);
  const running = db.prepare(
    "SELECT 1 FROM task WHERE assignee_agent_id=? AND state IN ('claimed','running') LIMIT 1",
  ).get(id);
  db.prepare('UPDATE agent_definition SET availability_state=?, updated_at=? WHERE id=?').run(
    running ? 'draining' : 'off',
    nowIso(),
    id,
  );
  return getAgent(db, id);
}

/** 将已经完成手头工作的 draining 员工转为 off。 */
export function settleDrainingAgents(db: DB, companyId: string): string[] {
  const settled: string[] = [];
  for (const agent of listAgents(db, companyId)) {
    if (agent.availabilityState !== 'draining') continue;
    const running = db.prepare(
      "SELECT 1 FROM task WHERE assignee_agent_id=? AND state IN ('claimed','running') LIMIT 1",
    ).get(agent.id);
    if (!running) {
      db.prepare("UPDATE agent_definition SET availability_state='off', updated_at=? WHERE id=?").run(nowIso(), agent.id);
      settled.push(agent.id);
    }
  }
  return settled;
}
