/**
 * Agent Definition 领域：员工 CRUD + 组织配置锁校验。
 *
 * 上班期间（公司非 off）禁止增删改员工。
 * 角色冲突（如同一员工不能同时是 lead + writer）由调用方在项目层校验。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getWorkbench, isOrgLocked } from './workbench';
import { assertDepartmentInCompany } from './department';
import {
  createAgentProfile,
  createCompanyEmployeeRecord,
  getAgentProfile,
  syncCompanyEmployeeRecord,
} from './agent-profile';

export interface AgentDefinition {
  id: string;
  profileId: string;
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
  /** 立场/视角：讨论/辩论时锁定 Agent 观点，防止盲目跟风。空 = 不注入。 */
  stance: string;
  /** 指挥系统：系统隐形岗（养蜂人/裁决法庭），用户不可见不可控，任职记录 hidden=1。 */
  isSystem: boolean;
  availabilityState: 'online' | 'draining' | 'off';
  createdAt: string;
  updatedAt: string;
  /** 公司任职绑定的固定执行器档案（来自 company_employee.executor_profile_id）。 */
  executorProfileId?: string | null;
  /** 公司任职绑定的权限策略（来自 company_employee.permission_policy_id）。 */
  permissionPolicyId?: string | null;
}

/**
 员工级执行器配置（executor_json 结构，PRD Phase 3）。
 所有字段可选，缺省回退到系统级 SystemSettings。
 - provider：执行器类型（claude-cli / openai / gemini），决定引擎分发到哪个 adapter。
 - apiKeyEnv：用户级凭据引用，存环境变量名（如 ANTHROPIC_API_KEY_BOB），不存明文。
   spawn Claude 时把 process.env[apiKeyEnv] 注入子进程 ANTHROPIC_API_KEY；
   OpenAI/Gemini adapter 同理注入各自的环境变量。
   合法变量名必须匹配 /^[A-Z][A-Z0-9_]*$/，否则在引擎侧被忽略。
 - baseURL：OpenAI 兼容 API 的 baseURL（provider=openai 时生效）。
 */
export interface AgentExecutorJson {
  provider?: string;
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
  maxToolCalls?: number;
  skipPermissions?: boolean;
  apiKeyEnv?: string;
  baseURL?: string;
}

interface AgentRow {
  id: string;
  profile_id: string;
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
  stance: string;
  is_system: number;
  availability_state: 'online' | 'draining' | 'off';
  created_at: string;
  updated_at: string;
}

function fromRow(db: DB, r: AgentRow): AgentDefinition {
  return {
    id: r.id,
    profileId: r.profile_id,
    companyId: getWorkbench(db).id,
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
    stance: r.stance ?? '',
    isSystem: (r as { is_system?: number }).is_system === 1,
    availabilityState: r.availability_state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateAgentInput {
  profileId?: string;
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
  stance?: string;
  /** 临时工招聘豁免：跳过 org lock（允许 online 态招临时工）。仅 temp-worker.ts 走此路径。 */
  tempRecruit?: boolean;
  /** 指挥系统：系统隐形岗创建（豁免 org lock，任职记录 hidden=1）。仅 system-agents.ts / swarm.ts 走此路径。 */
  isSystem?: boolean;
  /** R2 内部固定岗豁免：验收员等可见岗位懒确保（豁免 org lock 但不 hidden——区别于 isSystem）。 */
  internalRecruit?: boolean;
}

function assertUnlocked(db: DB, opts?: { tempRecruit?: boolean; isSystem?: boolean; internalRecruit?: boolean }): void {
  // 临时工招聘豁免：允许公司 online 态招临时工（B2B 决策树 recruit 路径自动触发）
  // 系统隐形岗豁免：养蜂人/裁决法庭由 coordinator 在线幂等创建
  // R2 内部岗豁免：验收员等可见固定岗懒确保（任务完成时工作台通常 online，不豁免则永远建不出来）
  if (opts?.tempRecruit || opts?.isSystem || opts?.internalRecruit) return;
  // 2026-08-23 用户定案：上下班退役——员工配置锁只在有任务执行中时生效（防执行期竞态）
  if (isOrgLocked(db)) {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '有任务执行中，暂不能修改员工配置');
  }
}

function assertContactAllow(db: DB, contactAllow: string[]): void {
  if (contactAllow.length === 0) return;
  const placeholders = contactAllow.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id FROM agent_definition WHERE id IN (${placeholders})`,
  ).all(...contactAllow) as Array<{ id: string }>;
  const valid = new Set(rows.map((row) => row.id));
  const invalid = contactAllow.filter((id) => !valid.has(id));
  if (invalid.length > 0) {
    throw new AppError(ErrorCode.VALIDATION, `联系人必须是本公司员工：${invalid.join(', ')}`);
  }
}

/**
 校验 executor_json（PRD Phase 3）。
 - apiKeyEnv 必须匹配 /^[A-Z][A-Z0-9_]*$/，防止注入非法字符或明文 key。
 - model/claudeBin 必须是非空字符串。
 - timeoutMs/maxToolCalls 必须是正数。
 */
function assertExecutorValid(executor: Record<string, unknown> | undefined): void {
  if (!executor) return;
  if (typeof executor !== 'object') {
    throw new AppError(ErrorCode.VALIDATION, 'executor 必须是对象');
  }
  if (executor.apiKeyEnv !== undefined) {
    if (typeof executor.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(executor.apiKeyEnv)) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'apiKeyEnv 必须是合法的环境变量名（大写字母/数字/下划线，字母开头）',
      );
    }
  }
  if (executor.provider !== undefined) {
    const validProviders = ['claude-cli', 'openai', 'gemini'];
    if (typeof executor.provider !== 'string' || !validProviders.includes(executor.provider)) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `executor.provider 必须是 ${validProviders.join(' / ')} 之一`,
      );
    }
  }
  if (executor.model !== undefined && (typeof executor.model !== 'string' || !executor.model)) {
    throw new AppError(ErrorCode.VALIDATION, 'executor.model 必须是非空字符串');
  }
  if (executor.claudeBin !== undefined && (typeof executor.claudeBin !== 'string' || !executor.claudeBin)) {
    throw new AppError(ErrorCode.VALIDATION, 'executor.claudeBin 必须是非空字符串');
  }
  if (executor.baseURL !== undefined && (typeof executor.baseURL !== 'string' || !executor.baseURL)) {
    throw new AppError(ErrorCode.VALIDATION, 'executor.baseURL 必须是非空字符串');
  }
  if (executor.timeoutMs !== undefined && (typeof executor.timeoutMs !== 'number' || executor.timeoutMs <= 0)) {
    throw new AppError(ErrorCode.VALIDATION, 'executor.timeoutMs 必须是正数');
  }
  if (executor.maxToolCalls !== undefined && (typeof executor.maxToolCalls !== 'number' || executor.maxToolCalls <= 0)) {
    throw new AppError(ErrorCode.VALIDATION, 'executor.maxToolCalls 必须是正数');
  }
  if (executor.skipPermissions !== undefined && typeof executor.skipPermissions !== 'boolean') {
    throw new AppError(ErrorCode.VALIDATION, 'executor.skipPermissions 必须是布尔值');
  }
}

export function createAgent(db: DB, input: CreateAgentInput): AgentDefinition {
  getWorkbench(db); // 校验工作台存在
  assertUnlocked(db, { tempRecruit: input.tempRecruit, isSystem: input.isSystem, internalRecruit: input.internalRecruit });
  assertDepartmentInCompany(db, input.departmentId ?? null);
  // 临时工招聘豁免 contactAllow 校验（临时工的工作关系仅限发起者，可能跨公司）
  if (!input.tempRecruit && !input.isSystem) {
    assertContactAllow(db, input.contactAllow ?? []);
  }
  assertExecutorValid(input.executor);

  return db.transaction(() => {
    const profile = input.profileId
      ? getAgentProfile(db, input.profileId)
      : createAgentProfile(db, {
          displayName: input.name,
          soul: input.systemPrompt,
          capabilities: { skills: input.skills ?? [], tools: input.tools ?? [] },
          recommendedExecutor: input.executor,
          recommendedPermission: input.permissions,
        });
    const id = shortId('ag_');
    const now = nowIso();
    db.prepare(
      `INSERT INTO agent_definition
        (id, profile_id, department_id, name, role, responsibilities, system_prompt,
         skills_json, tools_json, permissions_json, contact_allow_json, can_dispatch,
         executor_json, is_inspector, stance, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, profile.id, input.departmentId ?? null, input.name || profile.displayName, input.role,
      input.responsibilities ?? '', input.systemPrompt ?? profile.soul,
      JSON.stringify(input.skills ?? []), JSON.stringify(input.tools ?? []),
      JSON.stringify(input.permissions ?? {}), JSON.stringify(input.contactAllow ?? []),
      input.canDispatch === false ? 0 : 1, JSON.stringify(input.executor ?? {}),
      input.isInspector ? 1 : 0, input.stance ?? '', input.isSystem ? 1 : 0, now, now,
    );
    createCompanyEmployeeRecord(db, {
      id,
      profileId: profile.id,
      legacyAgentId: id,
      departmentId: input.departmentId,
      role: input.role,
      responsibilities: input.responsibilities,
      executor: input.executor,
      permission: input.permissions,
      createdAt: now,
    });
    // 系统隐形岗：任职记录标记 hidden（花名册/能力路由过滤，但可领取任务）
    if (input.isSystem) {
      db.prepare('UPDATE company_employee SET hidden=1 WHERE legacy_agent_id=?').run(id);
    }
    return getAgent(db, id);
  })();
}

export function recruitAgentProfile(db: DB, input: {
  profileId: string;
  role: string;
  departmentId?: string;
  responsibilities?: string;
}): AgentDefinition {
  const profile = getAgentProfile(db, input.profileId);
  const capabilities = profile.capabilities as { skills?: string[]; tools?: string[] };
  return createAgent(db, {
    ...input,
    name: profile.displayName,
    systemPrompt: profile.soul,
    skills: capabilities.skills ?? [],
    tools: capabilities.tools ?? [],
    executor: profile.recommendedExecutor,
    permissions: profile.recommendedPermission,
  });
}

export function getAgent(db: DB, id: string): AgentDefinition {
  const row = db.prepare('SELECT * FROM agent_definition WHERE id = ?').get(id) as AgentRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `agent ${id} not found`);
  return withEmploymentBindings(db, fromRow(db, row));
}

/**
 * 列出公司员工。默认过滤 hidden 任职（系统隐形岗 + 蜂群临时工蜂）——
 * 花名册/能力路由/组织图均走此处，一处过滤全面生效；内部系统逻辑传 includeHidden。
 * B5 中央岗：visibleIn 按分区取（如 'central' 取中央六岗——@ 下拉/群聊候选专用，hidden 不影响）。
 */
export function listAgents(db: DB, options?: { includeHidden?: boolean; visibleIn?: string }): AgentDefinition[] {
  const rows = (
    options?.includeHidden
      ? db.prepare('SELECT * FROM agent_definition ORDER BY created_at').all()
      : options?.visibleIn
        ? db.prepare('SELECT * FROM agent_definition WHERE visible_in=? ORDER BY created_at').all(options.visibleIn)
        : db.prepare(
          `SELECT a.* FROM agent_definition a
           WHERE NOT EXISTS (
             SELECT 1 FROM company_employee ce
             WHERE ce.legacy_agent_id = a.id AND ce.hidden = 1
           )
           ORDER BY a.created_at`,
        ).all()
  ) as AgentRow[];
  return rows.map((row) => withEmploymentBindings(db, fromRow(db, row)));
}

/**
 * 持久员工清单（审查修复）：报表/备份/驾驶舱的观测口径——可见花名册 + 隐形中央岗 + greyed 临时工，
 * 排除一次性执行体（蜂群工蜂 swarm-worker / 辩手 debater——活跃蜂群期间的备份快照会把它们变成
 * 恢复后的僵尸员工，报表也会被逐蜂条目灌爆）。
 */
export function listPersistentAgents(db: DB): AgentDefinition[] {
  const rows = db.prepare(
    `SELECT * FROM agent_definition
     WHERE role NOT IN ('swarm-worker', 'debater')
     ORDER BY created_at`,
  ).all() as AgentRow[];
  return rows.map((row) => withEmploymentBindings(db, fromRow(db, row)));
}

/** 附带 company_employee 表的执行器/权限绑定（legacy_agent_id 与 agent_definition.id 同值）。 */
function withEmploymentBindings(db: DB, agent: AgentDefinition): AgentDefinition {
  const row = db.prepare(
    'SELECT executor_profile_id, permission_policy_id FROM company_employee WHERE legacy_agent_id=?',
  ).get(agent.id) as { executor_profile_id: string | null; permission_policy_id: string | null } | undefined;
  return {
    ...agent,
    executorProfileId: row?.executor_profile_id ?? null,
    permissionPolicyId: row?.permission_policy_id ?? null,
  };
}

export function updateAgent(
  db: DB,
  id: string,
  patch: Partial<Omit<AgentDefinition, 'id' | 'companyId' | 'createdAt' | 'availabilityState'>>,
): AgentDefinition {
  const cur = getAgent(db, id);
  assertUnlocked(db);
  const next: AgentDefinition = {
    ...cur,
    ...patch,
    updatedAt: nowIso(),
  };
  assertDepartmentInCompany(db, next.departmentId);
  assertContactAllow(db, next.contactAllow);
  assertExecutorValid(next.executor);
  db.prepare(
    `UPDATE agent_definition SET
      department_id=?, name=?, role=?, responsibilities=?, system_prompt=?,
      skills_json=?, tools_json=?, permissions_json=?, contact_allow_json=?,
      can_dispatch=?, executor_json=?, is_inspector=?, stance=?, updated_at=?
     WHERE id=?`,
  ).run(
    next.departmentId, next.name, next.role, next.responsibilities, next.systemPrompt,
    JSON.stringify(next.skills), JSON.stringify(next.tools),
    JSON.stringify(next.permissions), JSON.stringify(next.contactAllow),
    next.canDispatch ? 1 : 0, JSON.stringify(next.executor), next.isInspector ? 1 : 0,
    next.stance ?? '',
    next.updatedAt, id,
  );
  syncCompanyEmployeeRecord(db, {
    id,
    departmentId: next.departmentId,
    role: next.role,
    responsibilities: next.responsibilities,
    executor: next.executor,
    permission: next.permissions,
    updatedAt: next.updatedAt,
  });
  return getAgent(db, id);
}

export function deleteAgent(db: DB, id: string): void {
  const cur = getAgent(db, id);
  assertUnlocked(db);
  if (cur.isInspector) {
    throw new AppError(ErrorCode.CONFLICT, '监察员工是系统稳定性岗位，不能删除；可以修改配置');
  }
  // 若该员工是工作台/项目的第一负责人，先清除（防 DEFERRABLE FK 冲突）
  db.transaction(() => {
    db.prepare('UPDATE workbench SET first_agent_id=NULL WHERE first_agent_id=?').run(id);
    db.prepare('UPDATE project SET first_agent_id=NULL WHERE first_agent_id=?').run(id);
    db.prepare('DELETE FROM agent_definition WHERE id=?').run(id);
  })();
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
export function settleDrainingAgents(db: DB): string[] {
  const settled: string[] = [];
  for (const agent of listAgents(db)) {
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
