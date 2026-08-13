import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { getExecutorManifest, type ExecutorConcurrency, type ExecutorManifest } from '../executors/manifests';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { redactSensitiveText } from '../../shared/redaction';
import { DEFAULT_MAX_CONCURRENCY } from './executor-concurrency';

export type CredentialReference = { kind: 'env' | 'keychain' | 'cli-login' | 'encrypted-local'; reference: string };

export interface ExecutorProfile {
  id: string;
  name: string;
  manifestId: string;
  manifestVersion: number;
  config: Record<string, unknown>;
  credentialRef: Partial<CredentialReference>;
  install: Record<string, unknown>;
  concurrencyMode: ExecutorConcurrency;
  /** 并发硬上限（settings-overhaul B4；默认 4）。 */
  maxConcurrency: number;
  /** 锁定后自适应不越界不上调（B4）。 */
  concurrencyLocked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionRun {
  id: string;
  executorProfileId: string;
  employeeId: string;
  projectId: string;
  taskId: string;
  status: 'created' | 'running' | 'completed' | 'failed' | 'cancelled';
  manifestSnapshot: ExecutorManifest;
  profileSnapshot: ExecutorProfile;
  startedAt: string | null;
  finishedAt: string | null;
  failureClassification: string | null;
  failureMessage: string | null;
  createdAt: string;
}

type ProfileRow = { id: string; name: string; manifest_id: string; manifest_version: number; config_json: string; credential_ref_json: string; install_json: string; concurrency_mode: ExecutorConcurrency; max_concurrency: number | null; concurrency_locked: number | null; effective_concurrency: number | null; created_at: string; updated_at: string };
type RunRow = { id: string; executor_profile_id: string; employee_id: string; project_id: string; task_id: string; status: ExecutionRun['status']; manifest_snapshot_json: string; profile_snapshot_json: string; started_at: string | null; finished_at: string | null; failure_classification: string | null; failure_message: string | null; created_at: string };

function profileFromRow(row: ProfileRow): ExecutorProfile {
  return { id: row.id, name: row.name, manifestId: row.manifest_id, manifestVersion: row.manifest_version, config: JSON.parse(row.config_json), credentialRef: JSON.parse(row.credential_ref_json), install: JSON.parse(row.install_json), concurrencyMode: row.concurrency_mode, maxConcurrency: row.max_concurrency ?? DEFAULT_MAX_CONCURRENCY, concurrencyLocked: (row.concurrency_locked ?? 0) === 1, createdAt: row.created_at, updatedAt: row.updated_at };
}

function assertNoSecretValues(value: unknown, path = 'config'): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(api[-_]?key|access[-_]?token|secret|password|credential)/i.test(key) && typeof child === 'string' && child.trim()) {
      throw new AppError(ErrorCode.VALIDATION, `${path}.${key} 不得保存凭据值，请使用 credentialRef`);
    }
    assertNoSecretValues(child, `${path}.${key}`);
  }
}

export function createExecutorProfile(db: DB, input: { name: string; manifestId: string; config?: Record<string, unknown>; credentialRef?: CredentialReference; install?: Record<string, unknown>; concurrencyMode?: ExecutorConcurrency; maxConcurrency?: number; concurrencyLocked?: boolean }): ExecutorProfile {
  const name = input.name.trim();
  if (!name) throw new AppError(ErrorCode.VALIDATION, '执行器档案名称不能为空');
  const manifest = getExecutorManifest(input.manifestId);
  assertNoSecretValues(input.config);
  if (manifest.id === 'custom-cli') {
    const binaryPath = input.config?.binaryPath;
    if (typeof binaryPath !== 'string' || !isAbsolute(binaryPath) || !existsSync(binaryPath)) {
      throw new AppError(ErrorCode.VALIDATION, '自定义 CLI 必须填写存在的可执行文件绝对路径');
    }
    if (input.config?.customArgs !== undefined && (!Array.isArray(input.config.customArgs) || !input.config.customArgs.every((item) => typeof item === 'string'))) {
      throw new AppError(ErrorCode.VALIDATION, '自定义 CLI 参数模板必须是字符串数组');
    }
  }
  if (input.credentialRef && !/^[A-Z][A-Z0-9_]*$/.test(input.credentialRef.reference) && input.credentialRef.kind === 'env') {
    throw new AppError(ErrorCode.VALIDATION, '环境变量凭据引用格式无效');
  }
  const now = nowIso();
  const id = shortId('ep_');
  const maxConcurrency = input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  // effective_concurrency 初始化为 max：新档案从满并发开始（自适应只会下调/试探上调，不越过 max）。
  db.prepare(`INSERT INTO executor_profile (id,name,manifest_id,manifest_version,config_json,credential_ref_json,install_json,concurrency_mode,max_concurrency,concurrency_locked,effective_concurrency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, name, manifest.id, manifest.version, JSON.stringify(input.config ?? {}), JSON.stringify(input.credentialRef ?? {}), JSON.stringify(input.install ?? {}), input.concurrencyMode ?? manifest.concurrency, maxConcurrency, input.concurrencyLocked ? 1 : 0, maxConcurrency, now, now);
  return getExecutorProfile(db, id);
}

export function getExecutorProfile(db: DB, id: string): ExecutorProfile {
  const row = db.prepare('SELECT * FROM executor_profile WHERE id=?').get(id) as ProfileRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `执行器档案不存在: ${id}`);
  return profileFromRow(row);
}

export function listExecutorProfiles(db: DB): ExecutorProfile[] {
  return (db.prepare('SELECT * FROM executor_profile ORDER BY created_at, id').all() as ProfileRow[]).map(profileFromRow);
}

export function bindEmployeeExecutorProfile(db: DB, employeeId: string, executorProfileId: string): void {
  getExecutorProfile(db, executorProfileId);
  const employment = db.prepare('SELECT c.state FROM company_employee ce JOIN company c ON c.id=ce.company_id WHERE ce.id=?').get(employeeId) as { state: string } | undefined;
  if (!employment) throw new AppError(ErrorCode.NOT_FOUND, `公司员工不存在: ${employeeId}`);
  if (employment.state !== 'off') throw new AppError(ErrorCode.CONFLICT, '公司下班后才能修改员工执行器');
  const result = db.prepare('UPDATE company_employee SET executor_profile_id=?, updated_at=? WHERE id=?').run(executorProfileId, nowIso(), employeeId);
  if (result.changes !== 1) throw new AppError(ErrorCode.NOT_FOUND, `公司员工不存在: ${employeeId}`);
}

export function getEmployeeExecutorProfile(db: DB, employeeId: string): ExecutorProfile | null {
  const row = db.prepare('SELECT executor_profile_id FROM company_employee WHERE id=?').get(employeeId) as { executor_profile_id: string | null } | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `公司员工不存在: ${employeeId}`);
  return row.executor_profile_id ? getExecutorProfile(db, row.executor_profile_id) : null;
}

/** 阶段二任务 2.2：更新执行器档案（名称/配置/凭据引用/并发模式/并发上限与锁定）。 */
export function updateExecutorProfile(
  db: DB,
  id: string,
  patch: { name?: string; config?: Record<string, unknown>; credentialRef?: CredentialReference; concurrencyMode?: ExecutorConcurrency; maxConcurrency?: number; concurrencyLocked?: boolean },
): ExecutorProfile {
  const cur = getExecutorProfile(db, id);
  const nextName = patch.name?.trim() || cur.name;
  if (!nextName) throw new AppError(ErrorCode.VALIDATION, '执行器档案名称不能为空');
  if (patch.config !== undefined) assertNoSecretValues(patch.config);
  if (patch.credentialRef && !/^[A-Z][A-Z0-9_]*$/.test(patch.credentialRef.reference) && patch.credentialRef.kind === 'env') {
    throw new AppError(ErrorCode.VALIDATION, '环境变量凭据引用格式无效');
  }
  const nextMax = patch.maxConcurrency ?? cur.maxConcurrency;
  db.prepare(
    `UPDATE executor_profile SET name=?, config_json=?, credential_ref_json=?, concurrency_mode=?, max_concurrency=?, concurrency_locked=?, updated_at=? WHERE id=?`,
  ).run(
    nextName,
    JSON.stringify(patch.config ?? cur.config),
    JSON.stringify(patch.credentialRef ?? cur.credentialRef),
    patch.concurrencyMode ?? cur.concurrencyMode,
    nextMax,
    patch.concurrencyLocked !== undefined ? (patch.concurrencyLocked ? 1 : 0) : (cur.concurrencyLocked ? 1 : 0),
    nowIso(),
    id,
  );
  // 锁定/下调上限时同步收住 effective（不越界）；解锁时恢复 max 作为试探起点。
  db.prepare('UPDATE executor_profile SET effective_concurrency = MIN(effective_concurrency, ?) WHERE id = ?').run(nextMax, id);
  return getExecutorProfile(db, id);
}

/** 阶段二任务 2.2：删除执行器档案（先解除所有员工绑定引用）。 */
export function deleteExecutorProfile(db: DB, id: string): void {
  getExecutorProfile(db, id);
  // 解除员工绑定（executor_profile_id 置空），避免悬挂引用
  db.prepare('UPDATE company_employee SET executor_profile_id=NULL, updated_at=? WHERE executor_profile_id=?')
    .run(nowIso(), id);
  db.prepare('DELETE FROM connection_probe WHERE executor_profile_id=?').run(id);
  db.prepare('DELETE FROM executor_profile WHERE id=?').run(id);
}

export function createExecutionRun(db: DB, input: { executorProfileId: string; employeeId: string; projectId: string; taskId: string }): ExecutionRun {
  const profile = getExecutorProfile(db, input.executorProfileId);
  const manifest = getExecutorManifest(profile.manifestId);
  const id = shortId('run_');
  const createdAt = nowIso();
  db.prepare(`INSERT INTO execution_run (id,executor_profile_id,employee_id,project_id,task_id,status,manifest_snapshot_json,profile_snapshot_json,created_at) VALUES (?,?,?,?,?,'created',?,?,?)`).run(id, profile.id, input.employeeId, input.projectId, input.taskId, JSON.stringify(manifest), JSON.stringify(profile), createdAt);
  return getExecutionRun(db, id);
}

export function getExecutionRun(db: DB, id: string): ExecutionRun {
  const row = db.prepare('SELECT * FROM execution_run WHERE id=?').get(id) as RunRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `执行记录不存在: ${id}`);
  return { id: row.id, executorProfileId: row.executor_profile_id, employeeId: row.employee_id, projectId: row.project_id, taskId: row.task_id, status: row.status, manifestSnapshot: JSON.parse(row.manifest_snapshot_json), profileSnapshot: JSON.parse(row.profile_snapshot_json), startedAt: row.started_at, finishedAt: row.finished_at, failureClassification: row.failure_classification, failureMessage: row.failure_message, createdAt: row.created_at };
}

export function failExecutionRun(db: DB, id: string, classification: string, message: string): ExecutionRun {
  const result = db.prepare(`UPDATE execution_run SET status='failed', failure_classification=?, failure_message=?, finished_at=? WHERE id=?`).run(classification, redactSensitiveText(message).slice(0, 2_000), nowIso(), id);
  if (result.changes !== 1) throw new AppError(ErrorCode.NOT_FOUND, `执行记录不存在: ${id}`);
  return getExecutionRun(db, id);
}

export function updateExecutionRunStatus(db: DB, id: string, status: ExecutionRun['status']): ExecutionRun {
  const now = nowIso();
  const startedAt = status === 'running' ? now : null;
  const finishedAt = ['completed', 'failed', 'cancelled'].includes(status) ? now : null;
  const result = db.prepare(`UPDATE execution_run SET status=?, started_at=COALESCE(?,started_at), finished_at=COALESCE(?,finished_at) WHERE id=?`).run(status, startedAt, finishedAt, id);
  if (result.changes !== 1) throw new AppError(ErrorCode.NOT_FOUND, `执行记录不存在: ${id}`);
  return getExecutionRun(db, id);
}
