/**
 * P0-④ 记忆库卫生：候选积压提醒（纯查询）+ 软删/过期物理清理。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgentProfile } from '../../src/server/domain/agent-profile';
import {
  approveMemoryCandidate,
  createMemoryCandidate,
  deleteMemoryEntry,
  purgeStaleMemory,
  sweepMemoryBacklogNotice,
  MEMORY_BACKLOG_COUNT_THRESHOLD,
} from '../../src/server/domain/memory';
import { makeTestDb } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

function addPending(profileId: string, content: string): void {
  createMemoryCandidate(db, {
    profileId, scope: 'personal', content, author: 'agent', confidence: 0.5, canInfluence: true,
  });
}

describe('候选积压提醒（P0-④）', () => {
  it('超过条数门槛返回提醒文案', () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    for (let i = 0; i < MEMORY_BACKLOG_COUNT_THRESHOLD + 1; i++) addPending(profile.id, `候选 ${i}`);
    const notice = sweepMemoryBacklogNotice(db);
    expect(notice).toContain('记忆候选积压');
    expect(notice).toContain(`${MEMORY_BACKLOG_COUNT_THRESHOLD + 1} 条`);
  });

  it('最老候选超过 7 天返回提醒；少量新候选不提醒', () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    addPending(profile.id, '一条候选');
    expect(sweepMemoryBacklogNotice(db)).toBeNull();
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    db.prepare('UPDATE memory_candidate SET created_at=?').run(eightDaysAgo);
    const notice = sweepMemoryBacklogNotice(db);
    expect(notice).toContain('已等待 8 天');
  });
});

describe('过期物理清理（P0-④）', () => {
  it('软删超 90 天被物理清理（含子表）；未到期保留', () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    const old = createMemoryCandidate(db, {
      profileId: profile.id, scope: 'personal', content: '旧的', author: 'user', confidence: 1, canInfluence: true,
    });
    const oldEntry = approveMemoryCandidate(db, old.id, 'user');
    deleteMemoryEntry(db, oldEntry.id, 'user');
    const fresh = createMemoryCandidate(db, {
      profileId: profile.id, scope: 'personal', content: '新的', author: 'user', confidence: 1, canInfluence: true,
    });
    const freshEntry = approveMemoryCandidate(db, fresh.id, 'user');
    deleteMemoryEntry(db, freshEntry.id, 'user');

    const ninetyOneDaysAgo = new Date(Date.now() - 91 * 86_400_000).toISOString();
    db.prepare('UPDATE memory_entry SET updated_at=? WHERE id=?').run(ninetyOneDaysAgo, oldEntry.id);

    const purged = purgeStaleMemory(db);
    expect(purged.purgedDeleted).toBe(1);
    // 主行与子表全部消失
    expect(db.prepare('SELECT COUNT(*) AS c FROM memory_entry WHERE id=?').get(oldEntry.id)).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM memory_version WHERE entry_id=?').get(oldEntry.id)).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM memory_fts WHERE entry_id=?').get(oldEntry.id)).toMatchObject({ c: 0 });
    // 新近软删的保留
    expect(db.prepare('SELECT COUNT(*) AS c FROM memory_entry WHERE id=?').get(freshEntry.id)).toMatchObject({ c: 1 });
  });

  it('expires_at 过期超 30 天被清理；宽限期内保留', () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    const a = createMemoryCandidate(db, {
      profileId: profile.id, scope: 'personal', content: '过期已久', author: 'user', confidence: 1,
      canInfluence: true, expiresAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    });
    const b = createMemoryCandidate(db, {
      profileId: profile.id, scope: 'personal', content: '刚过期', author: 'user', confidence: 1,
      canInfluence: true, expiresAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    const entryA = approveMemoryCandidate(db, a.id, 'user');
    const entryB = approveMemoryCandidate(db, b.id, 'user');
    const purged = purgeStaleMemory(db);
    expect(purged.purgedExpired).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM memory_entry WHERE id=?').get(entryA.id)).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM memory_entry WHERE id=?').get(entryB.id)).toMatchObject({ c: 1 });
  });
});
