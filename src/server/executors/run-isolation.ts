import { join } from 'node:path';
import type { ExecutorConcurrency } from './manifests';

export interface RunIsolation {
  runRoot: string;
  configDir: string;
  tempDir: string;
  logDir: string;
  sessionDir: string;
  employeeId: string;
  profileId: string;
}

export function buildRunIsolation(musterHome: string, input: { runId: string; employeeId: string; profileId: string; threadId?: string }): RunIsolation {
  if (!/^[A-Za-z0-9_-]+$/.test(input.runId)) throw new Error('runId 格式无效');
  const runRoot = join(musterHome, 'runs', input.runId);
  return { runRoot, configDir: join(musterHome, 'agents', input.employeeId, 'executors', input.profileId), tempDir: join(runRoot, 'tmp'), logDir: join(runRoot, 'logs'), sessionDir: join(musterHome, 'agents', input.employeeId, 'sessions', input.threadId ?? input.runId), employeeId: input.employeeId, profileId: input.profileId };
}

const lockTails = new Map<string, Promise<void>>();

export async function withExecutorConcurrency<T>(mode: ExecutorConcurrency, profileId: string, work: () => Promise<T> | T): Promise<T> {
  if (mode === 'parallel') return work();
  const key = mode === 'global-serial' ? 'global' : `profile:${profileId}`;
  const previous = lockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  lockTails.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  }
}
