import { restoreWorkbench } from '../../src/server/domain/workbench';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import {
  copyAgentProfile,
  createAgentProfile,
  getAgentProfile,
  resetAgentProfileToBase,
  updateAgentProfile,
} from '../../src/server/domain/agent-profile';
;
import {
  createMemoryCandidate,
  listMemoryEntries,
  resetPersonalMemory,
} from '../../src/server/domain/memory';
import { recruitAgentProfile } from '../../src/server/domain/agent';
import { makeTestDb } from './setup';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

describe('Agent Profile reuse and reset', () => {
  it('仅能力复制创建独立 Profile，不复制记忆', () => {
    const source = createAgentProfile(db, {
      displayName: '源员工', soul: '基础身份', principles: ['先验证'], capabilities: { skills: ['review'] },
    });
    createMemoryCandidate(db, {
      profileId: source.id, scope: 'personal', content: '用户私人偏好', author: 'user', confidence: 1,
      canInfluence: true, allowAutoApprove: true,
    });

    const copy = copyAgentProfile(db, source.id, { mode: 'capability-copy', displayName: '能力副本' });

    expect(copy.id).not.toBe(source.id);
    expect(copy.capabilities).toEqual(source.capabilities);
    expect(listMemoryEntries(db, { profileId: copy.id })).toEqual([]);
  });

  it('完整快照复制选定个人记忆，之后独立成长', () => {
    const source = createAgentProfile(db, { displayName: '源员工', capabilities: { skills: ['analysis'] } });
    createMemoryCandidate(db, {
      profileId: source.id, scope: 'personal', content: '偏好使用表格', author: 'user', confidence: 1,
      canInfluence: true, allowAutoApprove: true,
    });

    const copy = copyAgentProfile(db, source.id, { mode: 'snapshot-copy', displayName: '快照副本' });
    const copiedEntry = listMemoryEntries(db, { profileId: copy.id })[0];

    expect(copiedEntry.content).toBe('偏好使用表格');
    expect(copiedEntry.profileId).toBe(copy.id);
    expect(listMemoryEntries(db, { profileId: source.id })).toHaveLength(1);
  });

  it('引用复用同一 Profile，但公司任职 ID 相互隔离', () => {
    const profile = createAgentProfile(db, { displayName: '共享员工' });
    const firstCompany = restoreWorkbench(db, { id: 'wb_fix_1', name: '甲公司' });
    const secondCompany = restoreWorkbench(db, { id: 'wb_fix_2', name: '乙公司' });
    const first = recruitAgentProfile(db, { companyId: firstCompany.id, profileId: profile.id, role: 'architect' });
    const second = recruitAgentProfile(db, { companyId: secondCompany.id, profileId: profile.id, role: 'reviewer' });

    expect(first.profileId).toBe(second.profileId);
    expect(first.id).not.toBe(second.id);
  });

  it('恢复基础能力不删除记忆，清空个人记忆不改变能力和任职', () => {
    const profile = createAgentProfile(db, { displayName: '员工', soul: '基础身份', capabilities: { skills: ['base'] } });
    const company = restoreWorkbench(db, { id: 'wb_fix_3', name: '公司' });
    recruitAgentProfile(db, { companyId: company.id, profileId: profile.id, role: 'engineer' });
    createMemoryCandidate(db, {
      profileId: profile.id, scope: 'personal', content: '私人经验', author: 'user', confidence: 1,
      canInfluence: true, allowAutoApprove: true,
    });
    updateAgentProfile(db, profile.id, { soul: '被修改身份', capabilities: { skills: ['changed'] } });

    const reset = resetAgentProfileToBase(db, profile.id);
    expect(reset).toMatchObject({ soul: '基础身份', capabilities: { skills: ['base'] } });
    expect(listMemoryEntries(db, { profileId: profile.id })).toHaveLength(1);

    resetPersonalMemory(db, profile.id, 'user');
    expect(listMemoryEntries(db, { profileId: profile.id })).toEqual([]);
    expect(getAgentProfile(db, profile.id).capabilities).toEqual({ skills: ['base'] });
  });
});
