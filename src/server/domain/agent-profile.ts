import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { copyPersonalMemoryEntries } from './memory';

export interface AgentProfile {
  id: string;
  displayName: string;
  soul: string;
  principles: string[];
  capabilities: Record<string, unknown>;
  recommendedExecutor: Record<string, unknown>;
  recommendedPermission: Record<string, unknown>;
  baseVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyEmployee {
  id: string;
  profileId: string;
  companyId: string;
  legacyAgentId: string;
  departmentId: string | null;
  role: string;
  responsibilities: string;
  executor: Record<string, unknown>;
  permission: Record<string, unknown>;
  executorProfileId: string | null;
  permissionPolicyId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProfileRow {
  id: string;
  display_name: string;
  soul: string;
  principles_json: string;
  capabilities_json: string;
  recommended_executor_json: string;
  recommended_permission_json: string;
  base_version: number;
  created_at: string;
  updated_at: string;
}

interface EmployeeRow {
  id: string;
  profile_id: string;
  company_id: string;
  legacy_agent_id: string;
  department_id: string | null;
  role: string;
  responsibilities: string;
  executor_json: string;
  permission_json: string;
  executor_profile_id: string | null;
  permission_policy_id: string | null;
  created_at: string;
  updated_at: string;
}

function profileFromRow(row: ProfileRow): AgentProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    soul: row.soul,
    principles: JSON.parse(row.principles_json),
    capabilities: JSON.parse(row.capabilities_json),
    recommendedExecutor: JSON.parse(row.recommended_executor_json),
    recommendedPermission: JSON.parse(row.recommended_permission_json),
    baseVersion: row.base_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function employeeFromRow(row: EmployeeRow): CompanyEmployee {
  return {
    id: row.id,
    profileId: row.profile_id,
    companyId: row.company_id,
    legacyAgentId: row.legacy_agent_id,
    departmentId: row.department_id,
    role: row.role,
    responsibilities: row.responsibilities,
    executor: JSON.parse(row.executor_json),
    permission: JSON.parse(row.permission_json),
    executorProfileId: row.executor_profile_id,
    permissionPolicyId: row.permission_policy_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAgentProfile(db: DB, input: {
  displayName: string;
  soul?: string;
  principles?: string[];
  capabilities?: Record<string, unknown>;
  recommendedExecutor?: Record<string, unknown>;
  recommendedPermission?: Record<string, unknown>;
}): AgentProfile {
  const displayName = input.displayName.trim();
  if (!displayName) throw new AppError(ErrorCode.VALIDATION, '员工档案名称不能为空');
  const id = shortId('ap_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO agent_profile (
      id, display_name, soul, principles_json, capabilities_json,
      recommended_executor_json, recommended_permission_json, base_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    displayName,
    input.soul ?? '',
    JSON.stringify(input.principles ?? []),
    JSON.stringify(input.capabilities ?? {}),
    JSON.stringify(input.recommendedExecutor ?? {}),
    JSON.stringify(input.recommendedPermission ?? {}),
    now,
    now,
  );
  const snapshot = {
    displayName,
    soul: input.soul ?? '',
    principles: input.principles ?? [],
    capabilities: input.capabilities ?? {},
    recommendedExecutor: input.recommendedExecutor ?? {},
    recommendedPermission: input.recommendedPermission ?? {},
  };
  db.prepare(
    'INSERT INTO agent_profile_base (profile_id, version, snapshot_json, created_at) VALUES (?, 1, ?, ?)',
  ).run(id, JSON.stringify(snapshot), now);
  return getAgentProfile(db, id);
}

export function getAgentProfile(db: DB, id: string): AgentProfile {
  const row = db.prepare('SELECT * FROM agent_profile WHERE id=?').get(id) as ProfileRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `agent profile ${id} not found`);
  return profileFromRow(row);
}

export function listAgentProfiles(db: DB): AgentProfile[] {
  return (db.prepare('SELECT * FROM agent_profile ORDER BY created_at, id').all() as ProfileRow[]).map(profileFromRow);
}

export function updateAgentProfile(db: DB, id: string, patch: Partial<Pick<AgentProfile,
  'displayName' | 'soul' | 'principles' | 'capabilities' | 'recommendedExecutor' | 'recommendedPermission'
>>): AgentProfile {
  const current = getAgentProfile(db, id);
  const next = { ...current, ...patch, updatedAt: nowIso() };
  if (!next.displayName.trim()) throw new AppError(ErrorCode.VALIDATION, '员工档案名称不能为空');
  db.prepare(
    `UPDATE agent_profile SET display_name=?, soul=?, principles_json=?, capabilities_json=?,
      recommended_executor_json=?, recommended_permission_json=?, updated_at=? WHERE id=?`,
  ).run(
    next.displayName.trim(), next.soul, JSON.stringify(next.principles), JSON.stringify(next.capabilities),
    JSON.stringify(next.recommendedExecutor), JSON.stringify(next.recommendedPermission), next.updatedAt, id,
  );
  return getAgentProfile(db, id);
}

export function createCompanyEmployeeRecord(db: DB, input: {
  id: string;
  profileId: string;
  companyId: string;
  legacyAgentId: string;
  departmentId?: string | null;
  role: string;
  responsibilities?: string;
  executor?: Record<string, unknown>;
  permission?: Record<string, unknown>;
  createdAt?: string;
}): CompanyEmployee {
  getAgentProfile(db, input.profileId);
  const now = input.createdAt ?? nowIso();
  db.prepare(
    `INSERT INTO company_employee (
      id, profile_id, company_id, legacy_agent_id, department_id, role,
      responsibilities, executor_json, permission_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id, input.profileId, input.companyId, input.legacyAgentId, input.departmentId ?? null,
    input.role, input.responsibilities ?? '', JSON.stringify(input.executor ?? {}),
    JSON.stringify(input.permission ?? {}), now, now,
  );
  return getCompanyEmployee(db, input.id);
}

export function getCompanyEmployee(db: DB, id: string): CompanyEmployee {
  const row = db.prepare('SELECT * FROM company_employee WHERE id=?').get(id) as EmployeeRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `company employee ${id} not found`);
  return employeeFromRow(row);
}

export function listProfileEmployments(db: DB, profileId: string): CompanyEmployee[] {
  getAgentProfile(db, profileId);
  return (db.prepare('SELECT * FROM company_employee WHERE profile_id=? ORDER BY created_at, id').all(profileId) as EmployeeRow[])
    .map(employeeFromRow);
}

export function syncCompanyEmployeeRecord(db: DB, input: {
  id: string;
  departmentId: string | null;
  role: string;
  responsibilities: string;
  executor: Record<string, unknown>;
  permission: Record<string, unknown>;
  updatedAt: string;
}): void {
  db.prepare(
    `UPDATE company_employee SET department_id=?, role=?, responsibilities=?, executor_json=?,
      permission_json=?, updated_at=? WHERE id=?`,
  ).run(
    input.departmentId, input.role, input.responsibilities, JSON.stringify(input.executor),
    JSON.stringify(input.permission), input.updatedAt, input.id,
  );
}

export function copyAgentProfile(db: DB, sourceId: string, input: {
  mode: 'capability-copy' | 'snapshot-copy';
  displayName?: string;
}): AgentProfile {
  const source = getAgentProfile(db, sourceId);
  const copy = createAgentProfile(db, {
    displayName: input.displayName?.trim() || `${source.displayName} 副本`,
    soul: source.soul,
    principles: [...source.principles],
    capabilities: structuredClone(source.capabilities),
    recommendedExecutor: structuredClone(source.recommendedExecutor),
    recommendedPermission: structuredClone(source.recommendedPermission),
  });
  if (input.mode === 'snapshot-copy') copyPersonalMemoryEntries(db, source.id, copy.id);
  return getAgentProfile(db, copy.id);
}

export function resetAgentProfileToBase(db: DB, id: string): AgentProfile {
  getAgentProfile(db, id);
  const row = db.prepare('SELECT snapshot_json, version FROM agent_profile_base WHERE profile_id=?').get(id) as
    | { snapshot_json: string; version: number }
    | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, '员工基础能力快照不存在');
  const snapshot = JSON.parse(row.snapshot_json) as {
    displayName: string; soul: string; principles: string[]; capabilities: Record<string, unknown>;
    recommendedExecutor: Record<string, unknown>; recommendedPermission: Record<string, unknown>;
  };
  db.prepare(
    `UPDATE agent_profile SET display_name=?, soul=?, principles_json=?, capabilities_json=?,
      recommended_executor_json=?, recommended_permission_json=?, base_version=?, updated_at=? WHERE id=?`,
  ).run(
    snapshot.displayName, snapshot.soul, JSON.stringify(snapshot.principles), JSON.stringify(snapshot.capabilities),
    JSON.stringify(snapshot.recommendedExecutor), JSON.stringify(snapshot.recommendedPermission), row.version, nowIso(), id,
  );
  return getAgentProfile(db, id);
}
