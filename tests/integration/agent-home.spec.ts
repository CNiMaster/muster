import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgentProfile, updateAgentProfile } from '../../src/server/domain/agent-profile';
import {
  exportCapabilityPackage,
  getAgentHomePath,
  materializeAgentHome,
  syncAgentIdentityFiles,
} from '../../src/server/domain/agent-home';
import { AppError } from '../../src/shared/errors';
import { makeTestDb } from './setup';

let db: DB;
let musterHome: string;

beforeEach(() => {
  db = makeTestDb().db;
  musterHome = mkdtempSync(join(tmpdir(), 'muster-agent-home-'));
});

describe('Agent Home', () => {
  it('幂等创建隔离目录与可读身份文件', () => {
    const profile = createAgentProfile(db, {
      displayName: '架构师',
      soul: '保持独立判断',
      principles: ['先理解约束'],
      capabilities: { skills: ['architecture'], tools: ['read_file'] },
    });

    const first = materializeAgentHome(profile, musterHome);
    const second = materializeAgentHome(profile, musterHome);

    expect(first).toBe(second);
    expect(readFileSync(join(first, 'profile/SOUL.md'), 'utf8')).toContain('保持独立判断');
    expect(readFileSync(join(first, 'profile/principles.md'), 'utf8')).toContain('先理解约束');
    expect(existsSync(join(first, 'memory/daily'))).toBe(true);
    expect(existsSync(join(first, 'sessions'))).toBe(true);
  });

  it('拒绝非 opaque Profile ID 逃逸 agents 根目录', () => {
    expect(() => getAgentHomePath('../outside', musterHome)).toThrowError(AppError);
    expect(() => getAgentHomePath('ap_/tmp', musterHome)).toThrowError(AppError);
  });

  it('身份更新原子同步到文件视图', () => {
    const profile = createAgentProfile(db, { displayName: '员工', soul: '旧身份' });
    materializeAgentHome(profile, musterHome);
    const updated = updateAgentProfile(db, profile.id, { soul: '新身份' });

    syncAgentIdentityFiles(updated, musterHome);

    expect(readFileSync(join(getAgentHomePath(profile.id, musterHome), 'profile/SOUL.md'), 'utf8')).toContain('新身份');
    expect(readdirSync(join(getAgentHomePath(profile.id, musterHome), 'profile')).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('能力导出不包含记忆、任职、会话、凭据或本地路径', () => {
    const profile = createAgentProfile(db, {
      displayName: '员工',
      soul: '稳定身份',
      capabilities: { skills: ['review'] },
      recommendedExecutor: { provider: 'claude-cli', apiKeyEnv: 'SECRET_TOKEN' },
    });
    materializeAgentHome(profile, musterHome);

    const exported = exportCapabilityPackage(profile);
    const serialized = JSON.stringify(exported);

    expect(exported).toMatchObject({ displayName: '员工', capabilities: { skills: ['review'] } });
    expect(serialized).not.toContain('SECRET_TOKEN');
    expect(serialized).not.toMatch(/memory|session|company|project|credential|\/tmp/i);
  });
});
