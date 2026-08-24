/**
 * 本机密钥托管（2026-08-25，用户定案：粘贴 Key 由 muster 内部落盘，不让新手去开终端）。
 *
 * 存储：`$MUSTER_HOME/env` 文件（KEY=value 每行一条，权限 600）——
 * 不进数据库、不进 git、不上传；与系统环境变量同一消费通道（process.env），
 * 现有凭据解析链（resolveExecutorCredentialEnv → process.env[名字]）零改动。
 * 写入时同步热注入当前进程：保存即生效，无需重启。
 * 启动时由 server 调 loadLocalEnvFile() 回灌（真实环境变量优先——文件不覆盖已存在的进程 env）。
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_CONFIG } from '../env';
import { AppError, ErrorCode } from '../../shared/errors';

/** 合法环境变量名：大写字母/数字/下划线。 */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function envFilePath(): string {
  return join(process.env.MUSTER_HOME ?? SERVER_CONFIG.musterDir, 'env');
}

/** 校验变量名；非法抛 400。 */
export function assertEnvName(name: string): string {
  const trimmed = name.trim();
  if (!ENV_NAME_RE.test(trimmed)) {
    throw new AppError(ErrorCode.VALIDATION, '变量名只能含大写字母、数字和下划线，且以字母或下划线开头');
  }
  return trimmed;
}

/**
 * 保存一个密钥：写入本机 env 文件（幂等更新同名行）并热注入当前进程。
 * value 为空串表示删除该条（撤销）。
 */
export function saveLocalSecret(name: string, value: string): { file: string; updated: boolean } {
  const key = assertEnvName(name);
  const path = envFilePath();
  const lines = existsSync(path)
    ? readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
    : [];
  const entry = `${key}=${value}`;
  const index = lines.findIndex((l) => l.split('=')[0] === key);
  let updated: boolean;
  if (value === '') {
    updated = index !== -1;
    if (index !== -1) lines.splice(index, 1);
    delete process.env[key];
  } else if (index !== -1) {
    updated = lines[index] !== entry;
    lines[index] = entry;
    process.env[key] = value;
  } else {
    updated = true;
    lines.push(entry);
    process.env[key] = value;
  }
  // 原子写 + 仅本用户可读写（600）
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${lines.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return { file: path, updated };
}

/** 启动时回灌：把 env 文件的键值注入 process.env（已存在的真实环境变量优先，不被覆盖）。 */
export function loadLocalEnvFile(): number {
  const path = envFilePath();
  if (!existsSync(path)) return 0;
  let count = 0;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!ENV_NAME_RE.test(key)) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
      count += 1;
    }
  }
  return count;
}

/** 该变量名是否已有可用值（进程 env 或本机 env 文件中）。 */
export function hasLocalSecret(name: string): boolean {
  const key = name.trim();
  if (!ENV_NAME_RE.test(key)) return false;
  if (process.env[key]) return true;
  const path = envFilePath();
  if (!existsSync(path)) return false;
  return readFileSync(path, 'utf-8').split('\n').some((l) => l.split('=')[0] === key && l.trim());
}
