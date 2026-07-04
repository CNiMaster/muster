/**
 * 进程级运行时配置。所有 process.env 读取集中在此。
 */
import { deepFreeze } from '../shared/utils';

function readPort(): number {
  const raw = process.env.MUSTER_PORT;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 3456;
}

function readHost(): string {
  return process.env.MUSTER_HOST ?? '127.0.0.1';
}

function readMusterDir(): string {
  return process.env.MUSTER_HOME ?? `${process.env.HOME ?? '/tmp'}/.muster`;
}

export const SERVER_CONFIG = deepFreeze({
  host: readHost(),
  port: readPort(),
  musterDir: readMusterDir(),
  dbPath: `${readMusterDir()}/muster.db`,
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  skipPermissions: process.env.MUSTER_SKIP_PERMISSIONS === 'true',
  isProd: process.env.NODE_ENV === 'production',
});

export type ServerConfig = typeof SERVER_CONFIG;
