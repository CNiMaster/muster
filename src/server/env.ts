/**
 * 进程级运行时配置。所有 process.env 读取集中在此。
 */
import fs from 'node:fs';
import path from 'node:path';
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

function readClaudeBin(): string {
  if (process.env.CLAUDE_BIN) {
    return process.env.CLAUDE_BIN;
  }
  const home = process.env.HOME;
  if (home) {
    const localBin = path.join(home, '.local/bin/claude');
    if (fs.existsSync(localBin)) {
      return localBin;
    }
  }
  return 'claude';
}

function readModel(): string {
  return process.env.MUSTER_MODEL ?? '';
}

export const SERVER_CONFIG = deepFreeze({
  host: readHost(),
  port: readPort(),
  musterDir: readMusterDir(),
  dbPath: `${readMusterDir()}/muster.db`,
  claudeBin: readClaudeBin(),
  model: readModel(),
  skipPermissions: process.env.MUSTER_SKIP_PERMISSIONS === 'true',
  isProd: process.env.NODE_ENV === 'production',
});

export type ServerConfig = typeof SERVER_CONFIG;
