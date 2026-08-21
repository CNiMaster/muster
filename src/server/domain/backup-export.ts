/**
 * 本地备份导出 / 导入（结构化配置备份）。
 *
 * 设计原则（用户确认）：
 * - 只备份「结构化数据」：公司/部门/员工/人才档案、技能（名称与安装来源）、
 *   插件/MCP 配置（凭据只备份引用名，不备份明文密钥）、用户修改过的预置。
 * - 不备份「公司文件」：工作目录、素材/产物文件、git worktree 不进备份——
 *   体积大且可能涉及隐私；由文件系统目录指引提示用户自行备份。
 * - 导出格式为单个 JSON（muster-backup），可本地保存、后续导入或上传账号同步。
 */
import type { DB } from '../db/client';
import { nowIso, shortId } from '../../shared/utils';
import { getWorkbench, restoreWorkbench } from './workbench';
import { createDepartment, listDepartments } from './department';
import { createAgentProfile, listAgentProfiles } from './agent-profile';
import { createAgent, listAgents } from './agent';
import { listProjects } from './project';
import { getMusterDirectories } from './muster-directories';
import { AppError, ErrorCode } from '../../shared/errors';

export const BACKUP_FORMAT = 'muster-backup';
export const BACKUP_VERSION = 1;

/** 导出：公司（含部门/员工/项目元数据）+ 人才档案 + 工具 + 插件 + 目录指引。 */
export function exportMusterBackup(db: DB): MusterBackup {
  // 公司退役批次D：公司坍缩为单例工作台，导出恒为单工作台。
  const wb = getWorkbench(db);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: nowIso(),
    companies: [
      {
        id: wb.id,
        name: wb.name,
        kind: wb.kind,
        charter: wb.charter,
        contractJson: wb.contractJson,
        archivedAt: null,
        departments: listDepartments(db).map((d) => ({ name: d.name, rules: d.rules })),
        // B5 观测修复：备份含隐形中央岗——否则导出丢员工（恢复后验收链路断人）
        employees: listAgents(db, { includeHidden: true }).map((a) => ({
          profileId: a.profileId,
          departmentName: a.departmentId ? listDepartments(db).find((d) => d.id === a.departmentId)?.name ?? null : null,
          name: a.name,
          role: a.role,
          responsibilities: a.responsibilities,
          systemPrompt: a.systemPrompt,
          skills: a.skills,
          tools: a.tools,
          permissions: a.permissions,
          contactAllow: a.contactAllow,
          canDispatch: a.canDispatch,
          executor: a.executor,
          isInspector: a.isInspector,
          stance: a.stance,
        })),
        projects: listProjects(db, wb.id).map((p) => ({
          name: p.name,
          description: p.description,
          state: p.state,
        })),
      }],
    profiles: listAgentProfiles(db, { includeTempOnly: true }).map((p) => ({
      id: p.id,
      displayName: p.displayName,
      soul: p.soul,
      principles: p.principles,
      capabilities: p.capabilities,
      recommendedExecutor: p.recommendedExecutor,
      recommendedPermission: p.recommendedPermission,
      rating: p.rating,
      isTempOnly: p.isTempOnly,
    })),
    tools: exportTools(db),
    plugins: exportPlugins(db),
    filesystem: exportFilesystemGuide(db),
  };
}

function exportTools(db: DB): MusterToolExport[] {
  const rows = db.prepare('SELECT id, capability_id, implementation, title, file_path, executor_kind, credential_keys, install_hint, check_hint, maturity, is_active, is_default FROM tool_registry').all() as Array<{
    id: string; capability_id: string; implementation: string; title: string; file_path: string;
    executor_kind: string; credential_keys: string; install_hint: string | null; check_hint: string | null;
    maturity: string; is_active: number; is_default: number;
  }>;
  // 只备份用户自定义/非默认的工具（builtin 工具随程序分发，无需备份）
  return rows
    .filter((r) => r.is_default === 0)
    .map((r) => ({
      id: r.id,
      capabilityId: r.capability_id,
      implementation: r.implementation,
      title: r.title,
      filePath: r.file_path,
      executorKind: r.executor_kind,
      credentialKeys: r.credential_keys,
      installHint: r.install_hint,
      checkHint: r.check_hint,
      maturity: r.maturity,
      isActive: Boolean(r.is_active),
    }));
}

function exportPlugins(db: DB): MusterPluginExport[] {
  const rows = db.prepare('SELECT id, name, kind, source_kind, source_ref, scope_level, scope_id, manifest_json, permissions_json, credential_keys_json, status, maturity FROM plugin').all() as Array<{
    id: string; name: string; kind: string; source_kind: string; source_ref: string | null;
    scope_level: string; scope_id: string | null; manifest_json: string; permissions_json: string | null;
    credential_keys_json: string | null; status: string; maturity: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    sourceKind: r.source_kind,
    sourceRef: r.source_ref,
    scopeLevel: r.scope_level,
    scopeId: r.scope_id,
    manifest: safeParse(r.manifest_json),
    permissions: r.permissions_json ? safeParse(r.permissions_json) : undefined,
    // 只备份凭据引用名（不含密钥值）
    credentialKeys: r.credential_keys_json ? safeParse(r.credential_keys_json) : undefined,
    status: r.status,
    maturity: r.maturity,
  }));
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function exportFilesystemGuide(db: DB): MusterFilesystemGuide {
  const dirs = getMusterDirectories(db);
  return {
    note: '公司文件/工作目录/素材产物不在备份包内。请自行备份以下目录（含隐私与体积考量）：',
    programDirs: [
      { path: dirs.musterHome, description: '程序数据根目录（数据库、配置、凭据引用）' },
      { path: dirs.dbPath, description: 'SQLite 数据库（含本备份导出的全部结构化数据，另存即完整备份）' },
    ],
    companyFileDirs: [
      { path: dirs.worktreesDir, description: '任务工作目录（git worktree）' },
      { path: dirs.companiesDir, description: '公司项目文件目录' },
      { path: dirs.agentsDir, description: '员工个人空间' },
    ],
  };
}

export interface MusterCompanyExport {
  id: string;
  name: string;
  kind: string;
  charter: string | null;
  contractJson: Record<string, unknown> | null;
  archivedAt: string | null;
  departments: Array<{ name: string; rules?: Record<string, unknown> }>;
  employees: Array<{
    profileId: string;
    departmentName: string | null;
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
    stance: string;
  }>;
  projects: Array<{ name: string; description: string; state: string }>;
}

export interface MusterToolExport {
  id: string;
  capabilityId: string;
  implementation: string;
  title: string;
  filePath: string;
  executorKind: string;
  credentialKeys: string;
  installHint: string | null;
  checkHint: string | null;
  maturity: string;
  isActive: boolean;
}

export interface MusterPluginExport {
  id: string;
  name: string;
  kind: string;
  sourceKind: string;
  sourceRef: string | null;
  scopeLevel: string;
  scopeId: string | null;
  manifest: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  credentialKeys?: Record<string, unknown>;
  status: string;
  maturity: string;
}

export interface MusterFilesystemGuide {
  note: string;
  programDirs: Array<{ path: string; description: string }>;
  companyFileDirs: Array<{ path: string; description: string }>;
}

export interface MusterBackup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  companies: MusterCompanyExport[];
  profiles: Array<{
    id: string;
    displayName: string;
    soul: string;
    principles: string[];
    capabilities: Record<string, unknown>;
    recommendedExecutor: Record<string, unknown>;
    recommendedPermission: Record<string, unknown>;
    rating: number;
    isTempOnly: number;
  }>;
  tools: MusterToolExport[];
  plugins: MusterPluginExport[];
  filesystem: MusterFilesystemGuide;
}

export interface ImportSummary {
  companiesCreated: number;
  employeesCreated: number;
  profilesCreated: number;
  warnings: string[];
}

/**
 * 从备份 JSON 导入。
 *
 * 原则：
 * - 公司重建为 off 状态（不自动上班），名字冲突自动加「（导入）」后缀。
 * - 员工档案：优先复用现有同名档案；否则新建（保留 soul/原则/能力/推荐执行器）。
 * - 部门按名称重建并映射到员工。
 * - 只重建结构化数据；公司文件、task 运行时、素材产物不导入（见 filesystem 指引）。
 */
export function importMusterBackup(db: DB, backup: MusterBackup): ImportSummary {
  if (backup.format !== BACKUP_FORMAT) {
    throw new AppError(ErrorCode.VALIDATION, `不是有效的备份文件（format=${backup.format}）`);
  }
  if (backup.version > BACKUP_VERSION) {
    throw new AppError(ErrorCode.VALIDATION, `备份版本过新（${backup.version}），请先升级 Muster 再导入`);
  }
  // 整体事务：任一公司/档案导入失败则全部回滚，避免留下半成品数据。
  return db.transaction(() => {
    const summary: ImportSummary = { companiesCreated: 0, employeesCreated: 0, profilesCreated: 0, warnings: [] };

    for (const company of backup.companies) {
      importCompany(db, company, backup, summary);
      summary.companiesCreated += 1;
    }
    // 人才档案：备份里未被公司引用的独立档案也导入（如用户改过的预置人）
    const existingNames = new Set(listAgentProfiles(db).map((p) => p.displayName));
    for (const profile of backup.profiles) {
      if (existingNames.has(profile.displayName)) continue;
      createAgentProfile(db, {
        displayName: profile.displayName,
        soul: profile.soul,
        principles: profile.principles,
        capabilities: profile.capabilities,
        recommendedExecutor: profile.recommendedExecutor,
        recommendedPermission: profile.recommendedPermission,
      });
      existingNames.add(profile.displayName);
      summary.profilesCreated += 1;
    }
    return summary;
  })();
}

function importCompany(db: DB, company: MusterCompanyExport, backup: MusterBackup, summary: ImportSummary): string {
  const name = uniquifyCompanyName(db, company.name);
  restoreWorkbench(db, {
    id: company.id,
    name,
    kind: company.kind,
    charter: company.charter ?? undefined,
    contractJson: company.contractJson ?? undefined,
  });
  const companyId = company.id;
  // 重建部门，记名称 → id 供员工映射
  const departmentIds = new Map<string, string>();
  for (const dept of company.departments) {
    const createdDept = createDepartment(db, { name: dept.name, rules: dept.rules });
    departmentIds.set(dept.name, createdDept.id);
  }
  // 重建员工（复用现有档案或新建）
  for (const emp of company.employees) {
    const profileId = findOrCreateProfile(db, emp, backup, summary);
    createAgent(db, {
      profileId,
      departmentId: emp.departmentName ? departmentIds.get(emp.departmentName) : undefined,
      name: emp.name,
      role: emp.role,
      responsibilities: emp.responsibilities,
      systemPrompt: emp.systemPrompt,
      skills: emp.skills,
      tools: emp.tools,
      permissions: emp.permissions,
      contactAllow: emp.contactAllow,
      canDispatch: emp.canDispatch,
      executor: emp.executor,
      isInspector: emp.isInspector,
      stance: emp.stance,
    });
    summary.employeesCreated += 1;
  }
  // 项目元数据：不重建运行时（文件不存在），仅记录提示
  if (company.projects.length > 0) {
    summary.warnings.push(`公司「${name}」有 ${company.projects.length} 个项目仅记录元数据（文件/任务未导入，请按备份中的目录指引恢复文件）`);
  }
  return companyId;
}

function uniquifyCompanyName(db: DB, base: string): string {
  let candidate = base;
  let suffix = 1;
  while (checkNameTaken(db, candidate)) {
    suffix += 1;
    candidate = `${base}（导入${suffix}）`;
  }
  return candidate;
}

function checkNameTaken(db: DB, name: string): boolean {
  return (db.prepare('SELECT COUNT(*) as n FROM workbench WHERE name=?').get(name) as { n: number }).n > 0;
}

/** 查找同名的现有档案；否则从备份档案重建（保留用户改过的预置人内容）。 */
function findOrCreateProfile(db: DB, emp: MusterCompanyExport['employees'][number], backup: MusterBackup, summary: ImportSummary): string {
  const existing = listAgentProfiles(db).find((p) => p.displayName === emp.name);
  if (existing) return existing.id;
  const backupProfile = backup.profiles.find((p) => p.id === emp.profileId)
    ?? backup.profiles.find((p) => p.displayName === emp.name);
  if (backupProfile) {
    const created = createAgentProfile(db, {
      displayName: backupProfile.displayName,
      soul: backupProfile.soul,
      principles: backupProfile.principles,
      capabilities: backupProfile.capabilities,
      recommendedExecutor: backupProfile.recommendedExecutor,
      recommendedPermission: backupProfile.recommendedPermission,
    });
    summary.profilesCreated += 1;
    return created.id;
  }
  // 备份里没有档案记录：用员工快照直接建
  const created = createAgentProfile(db, {
    displayName: emp.name,
    soul: emp.systemPrompt,
    capabilities: { skills: emp.skills, tools: emp.tools },
    recommendedExecutor: emp.executor,
    recommendedPermission: emp.permissions,
  });
  summary.profilesCreated += 1;
  return created.id;
}
