import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AppError, ErrorCode } from '../../shared/errors';
import type { AgentProfile } from './agent-profile';
import { SERVER_CONFIG } from '../env';
import type { DB } from '../db/client';
import { listMemoryEntries } from './memory';

const PROFILE_ID_PATTERN = /^ap_[A-Za-z0-9_-]+$/;

export function getAgentHomePath(profileId: string, musterHome = SERVER_CONFIG.musterDir): string {
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new AppError(ErrorCode.VALIDATION, '无效的员工档案 ID');
  }
  const agentsRoot = resolve(musterHome, 'agents');
  const home = resolve(agentsRoot, profileId);
  if (!home.startsWith(`${agentsRoot}/`)) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '员工目录超出 Agent Home 根目录');
  }
  return home;
}

export function materializeAgentHome(profile: AgentProfile, musterHome = SERVER_CONFIG.musterDir): string {
  const home = getAgentHomePath(profile.id, musterHome);
  for (const relative of [
    'profile/skills',
    'memory/daily',
    'memory/lessons',
    'memory/index',
    'companies',
    'projects',
    'sessions',
    'scratch',
  ]) {
    mkdirSync(join(home, relative), { recursive: true, mode: 0o700 });
  }
  syncAgentIdentityFiles(profile, musterHome);
  writeIfMissing(join(home, 'memory/CORE.md'), '# 核心记忆\n\n');
  writeIfMissing(join(home, 'memory/USER.md'), '# 用户偏好\n\n');
  return home;
}

export function syncAgentIdentityFiles(profile: AgentProfile, musterHome = SERVER_CONFIG.musterDir): void {
  const home = getAgentHomePath(profile.id, musterHome);
  mkdirSync(join(home, 'profile'), { recursive: true, mode: 0o700 });
  atomicWrite(join(home, 'profile/SOUL.md'), `# ${profile.displayName}\n\n${profile.soul.trim()}\n`);
  atomicWrite(
    join(home, 'profile/principles.md'),
    `# 工作原则\n\n${profile.principles.map((item) => `- ${item}`).join('\n')}\n`,
  );
  atomicWrite(join(home, 'profile/capabilities.json'), `${JSON.stringify(profile.capabilities, null, 2)}\n`);
}

export function exportCapabilityPackage(profile: AgentProfile): Record<string, unknown> {
  const provider = typeof profile.recommendedExecutor.provider === 'string'
    ? profile.recommendedExecutor.provider
    : undefined;
  return {
    schemaVersion: 1,
    displayName: profile.displayName,
    soul: profile.soul,
    principles: profile.principles,
    capabilities: profile.capabilities,
    recommendedExecutorType: provider,
    recommendedPermission: profile.recommendedPermission,
    baseVersion: profile.baseVersion,
  };
}

export function syncAgentMemoryFiles(db: DB, profileId: string, musterHome = SERVER_CONFIG.musterDir): void {
  const home = getAgentHomePath(profileId, musterHome);
  const entries = listMemoryEntries(db, { profileId });
  atomicWrite(
    join(home, 'memory/USER.md'),
    renderMemorySnapshot('用户与个人记忆', entries.filter((entry) => entry.scope === 'personal')),
  );
  atomicWrite(
    join(home, 'memory/CORE.md'),
    renderMemorySnapshot('核心经验与 Skill', entries.filter((entry) => entry.scope === 'skill')),
  );
  const companyScoped = entries.filter((entry) => entry.scope === 'company');
  if (companyScoped.length > 0) {
    atomicWrite(join(home, 'companies', 'default', 'MEMORY.md'), renderMemorySnapshot('工作台任职记忆', companyScoped));
  }
  const projectIds = new Set(entries.flatMap((entry) => entry.projectId ? [entry.projectId] : []));
  for (const projectId of projectIds) {
    const scoped = entries.filter((entry) => entry.scope === 'project' && entry.projectId === projectId);
    atomicWrite(join(home, 'projects', projectId, 'MEMORY.md'), renderMemorySnapshot('项目记忆', scoped));
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function writeIfMissing(path: string, content: string): void {
  try {
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function renderMemorySnapshot(title: string, entries: Array<{ content: string; version: number; state: string }>): string {
  const lines = entries.map((entry) => `- ${entry.content}  <!-- v${entry.version} ${entry.state} -->`);
  return `# ${title}\n\n${lines.join('\n')}\n`;
}
