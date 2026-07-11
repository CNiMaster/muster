import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { getExecutorManifest, type ExecutorConcurrency, type ExecutorManifest } from '../executors/manifests';

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
  createdAt: string;
}

type ProfileRow = { id: string; name: string; manifest_id: string; manifest_version: number; config_json: string; credential_ref_json: string; install_json: string; concurrency_mode: ExecutorConcurrency; created_at: string; updated_at: string };
type RunRow = { id: string; executor_profile_id: string; employee_id: string; project_id: string; task_id: string; status: ExecutionRun['status']; manifest_snapshot_json: string; profile_snapshot_json: string; started_at: string | null; finished_at: string | null; created_at: string };

function profileFromRow(row: ProfileRow): ExecutorProfile {
  return { id: row.id, name: row.name, manifestId: row.manifest_id, manifestVersion: row.manifest_version, config: JSON.parse(row.config_json), credentialRef: JSON.parse(row.credential_ref_json), install: JSON.parse(row.install_json), concurrencyMode: row.concurrency_mode, createdAt: row.created_at, updatedAt: row.updated_at };
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

export function createExecutorProfile(db: DB, input: { name: string; manifestId: string; config?: Record<string, unknown>; credentialRef?: CredentialReference; install?: Record<string, unknown>; concurrencyMode?: ExecutorConcurrency }): ExecutorProfile {
  const name = input.name.trim();
  if (!name) throw new AppError(ErrorCode.VALIDATION, '执行器档案名称不能为空');
  const manifest = getExecutorManifest(input.manifestId);
  assertNoSecretValues(input.config);
  if (input.credentialRef && !/^[A-Z][A-Z0-9_]*$/.test(input.credentialRef.reference) && input.credentialRef.kind === 'env') {
    throw new AppError(ErrorCode.VALIDATION, '环境变量凭据引用格式无效');
  }
  const now = nowIso();
  const id = shortId('ep_');
  db.prepare(`INSERT INTO executor_profile (id,name,manifest_id,manifest_version,config_json,credential_ref_json,install_json,concurrency_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, name, manifest.id, manifest.version, JSON.stringify(input.config ?? {}), JSON.stringify(input.credentialRef ?? {}), JSON.stringify(input.install ?? {}), input.concurrencyMode ?? manifest.concurrency, now, now);
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
  return { id: row.id, executorProfileId: row.executor_profile_id, employeeId: row.employee_id, projectId: row.project_id, taskId: row.task_id, status: row.status, manifestSnapshot: JSON.parse(row.manifest_snapshot_json), profileSnapshot: JSON.parse(row.profile_snapshot_json), startedAt: row.started_at, finishedAt: row.finished_at, createdAt: row.created_at };
}
