import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { copyPersonalMemoryEntries } from './memory';
import { getPersona } from './persona-library';
import { getWorkbench } from './workbench';

export interface AgentProfile {
  id: string;
  displayName: string;
  soul: string;
  principles: string[];
  capabilities: Record<string, unknown>;
  recommendedExecutor: Record<string, unknown>;
  recommendedPermission: Record<string, unknown>;
  baseVersion: number;
  /** 1-5 星评级（经验越多越高）。 */
  rating: number;
  /** 1=临时新建、未转正（人才市场过滤掉）；转正时清零。 */
  isTempOnly: number;
  /** 'user' | 'system' | 'crystallized' */
  source: 'user' | 'system' | 'crystallized';
  /** 绑定的对应系统 Persona ID (如 'frontend/react-developer') */
  sourcePersonaId: string | null;
  /** 1=自动上岗（自动顶替官方人设），0=休息中（切回官方基准） */
  isAutoDispatch: number;
  /** 专属模型覆盖 */
  customModel: string | null;
  /** 专属思考深度覆盖 (off|low|med|high) */
  customThinkingDepth: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Employee {
  id: string;
  profileId: string;
  legacyAgentId: string;
  role: string;
  responsibilities: string;
  executor: Record<string, unknown>;
  permission: Record<string, unknown>;
  executorProfileId: string | null;
  permissionPolicyId: string | null;
  /** 'permanent' | 'temp'（临时工模型）。 */
  employmentType: 'permanent' | 'temp';
  /** 临时工状态（仅 temp 有意义）。 */
  tempStatus: 'active' | 'greyed' | 'dismissed' | null;
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
  rating: number;
  is_temp_only: number;
  source: string | null;
  source_persona_id: string | null;
  is_auto_dispatch: number | null;
  custom_model: string | null;
  custom_thinking_depth: string | null;
  created_at: string;
  updated_at: string;
}

interface EmployeeRow {
  id: string;
  profile_id: string;
  legacy_agent_id: string;
  role: string;
  responsibilities: string;
  executor_json: string;
  permission_json: string;
  executor_profile_id: string | null;
  permission_policy_id: string | null;
  employment_type: 'permanent' | 'temp';
  temp_status: 'active' | 'greyed' | 'dismissed' | null;
  created_at: string;
  updated_at: string;
}

function profileFromRow(row: ProfileRow): AgentProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    soul: row.soul,
    principles: JSON.parse(row.principles_json || '[]'),
    capabilities: JSON.parse(row.capabilities_json || '{}'),
    recommendedExecutor: JSON.parse(row.recommended_executor_json || '{}'),
    recommendedPermission: JSON.parse(row.recommended_permission_json || '{}'),
    baseVersion: row.base_version,
    rating: row.rating ?? 1,
    isTempOnly: row.is_temp_only ?? 0,
    source: (row.source as 'user' | 'system' | 'crystallized') || 'user',
    sourcePersonaId: row.source_persona_id ?? null,
    isAutoDispatch: row.is_auto_dispatch ?? 1,
    customModel: row.custom_model ?? null,
    customThinkingDepth: row.custom_thinking_depth ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function employeeFromRow(_db: DB, row: EmployeeRow): Employee {
  return {
    id: row.id,
    profileId: row.profile_id,
    legacyAgentId: row.legacy_agent_id,
    role: row.role,
    responsibilities: row.responsibilities,
    executor: JSON.parse(row.executor_json),
    permission: JSON.parse(row.permission_json),
    executorProfileId: row.executor_profile_id,
    permissionPolicyId: row.permission_policy_id,
    employmentType: (row.employment_type as 'permanent' | 'temp') ?? 'permanent',
    tempStatus: (row.temp_status as 'active' | 'greyed' | 'dismissed' | null) ?? null,
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
  /** 专家库 persona ID */
  personaId?: string;
  source?: 'user' | 'system' | 'crystallized';
  sourcePersonaId?: string | null;
  isAutoDispatch?: number;
  customModel?: string | null;
  customThinkingDepth?: string | null;
}): AgentProfile {
  const displayName = input.displayName.trim();
  if (!displayName) throw new AppError(ErrorCode.VALIDATION, '员工档案名称不能为空');
  let soul = input.soul;
  let principles = input.principles;
  let capabilities = input.capabilities;
  let sourcePersonaId = input.sourcePersonaId ?? null;

  if (input.personaId) {
    sourcePersonaId = input.personaId;
    const persona = getPersona(input.personaId);
    if (persona) {
      soul ??= persona.soul;
      principles ??= persona.principles;
      capabilities ??= persona.capabilities;
    }
  }

  const id = shortId('ap_');
  const now = nowIso();
  const source = input.source ?? 'user';
  const isAutoDispatch = input.isAutoDispatch ?? 1;

  db.prepare(
    `INSERT INTO agent_profile (
      id, display_name, soul, principles_json, capabilities_json,
      recommended_executor_json, recommended_permission_json, base_version,
      source, source_persona_id, is_auto_dispatch,
      custom_model, custom_thinking_depth, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    displayName,
    soul ?? '',
    JSON.stringify(principles ?? []),
    JSON.stringify(capabilities ?? {}),
    JSON.stringify(input.recommendedExecutor ?? {}),
    JSON.stringify(input.recommendedPermission ?? {}),
    source,
    sourcePersonaId,
    isAutoDispatch,
    input.customModel ?? null,
    input.customThinkingDepth ?? null,
    now,
    now,
  );

  const snapshot = {
    displayName,
    soul: soul ?? '',
    principles: principles ?? [],
    capabilities: capabilities ?? {},
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

/**
 * 「人设方法论档案」宿主 profile：一次性执行体（蜂群工蜂等）的 CRAFT 记忆归属。
 * 固定 id + is_temp_only=1（不进任何人才/档案列表）+ 无 agent/任职行（永不被 dismiss 删除）。
 * 记忆召回侧按 persona_key 全局命中 skill 记忆，宿主只是存储所有者，不参与执行。
 */
export const PERSONA_ARCHIVE_PROFILE_ID = 'ap_persona_archive';

export function ensurePersonaArchiveProfile(db: DB): string {
  const row = db.prepare('SELECT id FROM agent_profile WHERE id=?').get(PERSONA_ARCHIVE_PROFILE_ID) as
    | { id: string }
    | undefined;
  if (row) return PERSONA_ARCHIVE_PROFILE_ID;
  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_profile (id, display_name, soul, principles_json, capabilities_json,
        recommended_executor_json, recommended_permission_json, base_version, source, source_persona_id,
        is_auto_dispatch, is_temp_only, custom_model, custom_thinking_depth, created_at, updated_at)
       VALUES (?, '人设方法论档案', '', '[]', '{}', '{}', '{}', 1, 'system', NULL, 0, 1, NULL, NULL, ?, ?)`,
    ).run(PERSONA_ARCHIVE_PROFILE_ID, now, now);
    db.prepare('INSERT INTO agent_profile_base (profile_id, version, snapshot_json, created_at) VALUES (?, 1, ?, ?)').run(
      PERSONA_ARCHIVE_PROFILE_ID,
      JSON.stringify({ displayName: '人设方法论档案', soul: '', principles: [], capabilities: {}, recommendedExecutor: {}, recommendedPermission: {} }),
      now,
    );
  })();
  return PERSONA_ARCHIVE_PROFILE_ID;
}

export function listAgentProfiles(db: DB, opts?: { includeTempOnly?: boolean; source?: 'user' | 'system' | 'crystallized' }): AgentProfile[] {
  let sql = 'SELECT * FROM agent_profile WHERE 1=1';
  const params: unknown[] = [];
  // 批次 H.0 评审修：共享蜂档案是系统内部件（N 蜂共用），不进人才库/档案列表
  sql += ` AND id != 'ap_worker_bee_shared'`;
  if (!opts?.includeTempOnly) {
    sql += ' AND is_temp_only = 0';
  }
  if (opts?.source) {
    sql += ' AND source = ?';
    params.push(opts.source);
  }
  sql += ' ORDER BY rating DESC, created_at, id';
  return (db.prepare(sql).all(...params) as ProfileRow[]).map(profileFromRow);
}

/** 查询属于用户并处于开启「自动上岗」状态的同工种自定义人才。 */
export function findUserTalentForPersona(db: DB, personaId: string): AgentProfile | null {
  const row = db.prepare(
    "SELECT * FROM agent_profile WHERE source_persona_id=? AND source='user' AND is_auto_dispatch=1 AND is_temp_only=0 ORDER BY rating DESC, updated_at DESC LIMIT 1",
  ).get(personaId) as ProfileRow | undefined;
  return row ? profileFromRow(row) : null;
}

export function updateAgentProfile(db: DB, id: string, patch: Partial<Pick<AgentProfile,
  'displayName' | 'soul' | 'principles' | 'capabilities' | 'recommendedExecutor' | 'recommendedPermission'
  | 'isAutoDispatch' | 'customModel' | 'customThinkingDepth'
>>): AgentProfile {
  const current = getAgentProfile(db, id);
  const next = { ...current, ...patch, updatedAt: nowIso() };
  if (!next.displayName.trim()) throw new AppError(ErrorCode.VALIDATION, '员工档案名称不能为空');

  db.prepare(
    `UPDATE agent_profile SET display_name=?, soul=?, principles_json=?, capabilities_json=?,
      recommended_executor_json=?, recommended_permission_json=?, is_auto_dispatch=?,
      custom_model=?, custom_thinking_depth=?, updated_at=? WHERE id=?`,
  ).run(
    next.displayName.trim(),
    next.soul,
    JSON.stringify(next.principles),
    JSON.stringify(next.capabilities),
    JSON.stringify(next.recommendedExecutor),
    JSON.stringify(next.recommendedPermission),
    next.isAutoDispatch,
    next.customModel,
    next.customThinkingDepth,
    next.updatedAt,
    id,
  );
  return getAgentProfile(db, id);
}

/** 用户手动修改我的人才配置（仅允许修改 source === 'user' 的自有人才）。 */
export function updateUserCustomConfig(db: DB, id: string, input: {
  displayName?: string;
  soul?: string;
  principles?: string[];
  isAutoDispatch?: number;
  customModel?: string | null;
  customThinkingDepth?: string | null;
}): AgentProfile {
  const profile = getAgentProfile(db, id);
  if (profile.source !== 'user') {
    throw new AppError(ErrorCode.VALIDATION, '系统预置与沉淀专家由系统自动管理，如需调整请先「复制为我的人才」');
  }
  return updateAgentProfile(db, id, input);
}

/** 从系统专家或已有档案一键克隆为「我的人才」副本（source='user', isAutoDispatch=1）。 */
export function cloneProfileAsUser(db: DB, sourceProfileId: string, customName?: string): AgentProfile {
  const source = getAgentProfile(db, sourceProfileId);
  const name = customName?.trim() || `${source.displayName}（我的副本）`;
  return createAgentProfile(db, {
    displayName: name,
    soul: source.soul,
    principles: [...source.principles],
    capabilities: structuredClone(source.capabilities),
    recommendedExecutor: structuredClone(source.recommendedExecutor),
    recommendedPermission: structuredClone(source.recommendedPermission),
    source: 'user',
    sourcePersonaId: source.sourcePersonaId || source.id,
    isAutoDispatch: 1,
    customModel: source.customModel,
    customThinkingDepth: source.customThinkingDepth,
  });
}

/** 从 Persona 库一键克隆为「我的人才」。 */
export function clonePersonaAsUser(db: DB, personaId: string, customName?: string): AgentProfile {
  const persona = getPersona(personaId);
  if (!persona) throw new AppError(ErrorCode.NOT_FOUND, `Persona ${personaId} not found`);
  const name = customName?.trim() || `${persona.name}（我的定制）`;
  return createAgentProfile(db, {
    displayName: name,
    soul: persona.soul,
    principles: [...persona.principles],
    capabilities: structuredClone(persona.capabilities),
    source: 'user',
    sourcePersonaId: persona.id,
    isAutoDispatch: 1,
  });
}

export function createEmployeeRecord(db: DB, input: {
  id: string;
  profileId: string;
  legacyAgentId: string;
  role: string;
  responsibilities?: string;
  executor?: Record<string, unknown>;
  permission?: Record<string, unknown>;
  createdAt?: string;
}): Employee {
  getAgentProfile(db, input.profileId);
  const now = input.createdAt ?? nowIso();
  db.prepare(
    `INSERT INTO employee (
      id, profile_id, legacy_agent_id, role,
      responsibilities, executor_json, permission_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id, input.profileId, input.legacyAgentId,
    input.role, input.responsibilities ?? '', JSON.stringify(input.executor ?? {}),
    JSON.stringify(input.permission ?? {}), now, now,
  );
  return getEmployee(db, input.id);
}

export function getEmployee(db: DB, id: string): Employee {
  const row = db.prepare('SELECT * FROM employee WHERE id=?').get(id) as EmployeeRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `company employee ${id} not found`);
  return employeeFromRow(db, row);
}

export function listProfileEmployments(db: DB, profileId: string): Employee[] {
  getAgentProfile(db, profileId);
  return (db.prepare('SELECT * FROM employee WHERE profile_id=? ORDER BY created_at, id').all(profileId) as EmployeeRow[])
    .map((row) => employeeFromRow(db, row));
}

export function syncEmployeeRecord(db: DB, input: {
  id: string;
  role: string;
  responsibilities: string;
  executor: Record<string, unknown>;
  permission: Record<string, unknown>;
  updatedAt: string;
}): void {
  db.prepare(
    `UPDATE employee SET role=?, responsibilities=?, executor_json=?,
      permission_json=?, updated_at=? WHERE id=?`,
  ).run(
    input.role, input.responsibilities, JSON.stringify(input.executor),
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
    source: 'user',
    sourcePersonaId: source.sourcePersonaId || source.id,
    isAutoDispatch: 1,
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
