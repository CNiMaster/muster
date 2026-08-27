/**
 * 选择闭环 S4：记忆内务单测。
 * 口径守卫（spec 2026-08-27-selection-loop 定案）：
 * - 读时打标：fingerprint 扎堆 ≥2 与分区扎堆 ≥3 两信号；打标不影响注入结果
 * - 压实幂等：superseded 不再进脏集；强重复保留最新；误报哨兵复位
 * - 触发条件：脏 ≥20 / 新增 ≥50 / 7 天兜底（无脏不触发——O(脏分区) 不做全库扫）
 * - locked 条目永不 supersede
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { makeTestDb } from '../integration/setup';
import type { DB } from '../../src/server/db/client';
import {
  markCompactionDirty,
  runMemoryHousekeeping,
  getMemoryHealth,
} from '../../src/server/domain/memory-housekeeping';
import { createMemoryCandidate } from '../../src/server/domain/memory';
import { createAgentProfile } from '../../src/server/domain/agent-profile';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';

let db: DB;
let profileId: string;
let projectId: string;
beforeEach(() => {
  db = makeTestDb().db;
  const workbench = restoreWorkbench(db, { id: 'wb_hk', name: '内务测试' });
  projectId = createProject(db, { companyId: workbench.id, name: '内务项目', initialState: 'active' }).id;
  profileId = createAgentProfile(db, { displayName: '档案' }).id;
});

/** 落一条 active 记忆（allowAutoApprove 在 create 内部完成审批；按内容取回 entry id）。 */
function addEntry(content: string, fingerprint?: string): string {
  const candidate = createMemoryCandidate(db, {
    profileId,
    scope: 'project',
    projectId,
    content,
    author: 'agent',
    confidence: 1,
    canInfluence: true,
    allowAutoApprove: true,
  });
  const entry = db
    .prepare(`SELECT id FROM memory_entry WHERE source_candidate_id=?`)
    .get(candidate.id) as { id: string } | undefined;
  if (!entry) throw new Error(`entry not created for: ${content}`);
  if (fingerprint) {
    db.prepare(`UPDATE memory_entry SET fingerprint=? WHERE id=?`).run(fingerprint, entry.id);
  }
  return entry.id;
}

function dirtyOf(id: string): number {
  return (db.prepare(`SELECT compaction_dirty AS d FROM memory_entry WHERE id=?`).get(id) as { d: number }).d;
}

function stateOf(id: string): string {
  return (db.prepare(`SELECT state FROM memory_entry WHERE id=?`).get(id) as { state: string }).state;
}

describe('markCompactionDirty（读时打标）', () => {
  it('fingerprint 扎堆 ≥2 打标；独特指纹（独立分区）不打', () => {
    const otherProjectId = createProject(db, { companyId: 'wb_hk', name: '他项目', initialState: 'active' }).id;
    const a = addEntry('内容甲', 'fp-1');
    const b = addEntry('内容乙', 'fp-1');
    const c = addEntry('内容丙', 'fp-unique');
    markCompactionDirty(db, [
      { id: a, scope: 'project', profile_id: profileId, persona_key: null, project_id: projectId, fingerprint: 'fp-1' },
      { id: b, scope: 'project', profile_id: profileId, persona_key: null, project_id: projectId, fingerprint: 'fp-1' },
      { id: c, scope: 'project', profile_id: profileId, persona_key: null, project_id: otherProjectId, fingerprint: 'fp-unique' },
    ]);
    expect(dirtyOf(a)).toBe(1);
    expect(dirtyOf(b)).toBe(1);
    expect(dirtyOf(c)).toBe(0);
  });

  it('同分区命中 ≥3 打标（宽松哨兵，与指纹信号独立）', () => {
    const a = addEntry('内容一');
    const b = addEntry('内容二');
    const c = addEntry('内容三');
    markCompactionDirty(db, [a, b, c].map((id) => ({ id, scope: 'project', profile_id: profileId, persona_key: null, project_id: projectId, fingerprint: null })));
    expect(dirtyOf(a)).toBe(1);
    expect(dirtyOf(b)).toBe(1);
    expect(dirtyOf(c)).toBe(1);
  });

  it('两条不构成任何信号不打标（打标不误伤）', () => {
    const a = addEntry('唯一甲', 'fp-a');
    const b = addEntry('唯一乙', 'fp-b');
    markCompactionDirty(db, [
      { id: a, scope: 'project', profile_id: profileId, persona_key: null, project_id: projectId, fingerprint: 'fp-a' },
      { id: b, scope: 'project', profile_id: profileId, persona_key: null, project_id: projectId, fingerprint: 'fp-b' },
    ]);
    expect(dirtyOf(a)).toBe(0);
    expect(dirtyOf(b)).toBe(0);
  });
});

describe('runMemoryHousekeeping（摊销压实）', () => {
  it('强重复归并：同 fingerprint 保留最新，其余 superseded + cause 留痕', () => {
    const old1 = addEntry('旧内容', 'fp-dup');
    const new1 = addEntry('新内容', 'fp-dup');
    db.prepare(`UPDATE memory_entry SET updated_at=datetime('now','-2 day') WHERE id=?`).run(old1);
    markCompactionDirty(db, [
      { id: old1, scope: 'project', profile_id: profileId, persona_key: null, project_id: projectId, fingerprint: 'fp-dup' },
      { id: new1, scope: 'project', profile_id: profileId, persona_key: null, project_id: projectId, fingerprint: 'fp-dup' },
    ]);

    const result = runMemoryHousekeeping(db, { force: true });
    expect(result.triggered).toBe(true);
    expect(result.merged).toBe(1);
    expect(stateOf(old1)).toBe('superseded');
    expect(stateOf(new1)).toBe('active');
    const cause = (db.prepare(`SELECT cause FROM memory_entry WHERE id=?`).get(old1) as { cause: string | null }).cause;
    expect(cause).toBe('housekeeping-dedup');
  });

  it('同内容（无指纹，靠分区哨兵 ≥3 打标）也归并', () => {
    const a = addEntry('一模一样的话');
    const b = addEntry('一模一样的话');
    const c = addEntry('一模一样的话');
    markCompactionDirty(db, [a, b, c].map((id) => ({ id, scope: 'project', profile_id: profileId, persona_key: null, project_id: projectId, fingerprint: null })));
    const result = runMemoryHousekeeping(db, { force: true });
    expect(result.merged).toBe(2);
    expect([stateOf(a), stateOf(b), stateOf(c)].filter((s) => s === 'active')).toHaveLength(1);
  });

  it('幂等：superseded 不再进脏集，重复跑零合并；误报哨兵复位', () => {
    const a = addEntry('内容x', 'fp-idem');
    const b = addEntry('内容y', 'fp-idem');
    const c = addEntry('独特内容', null);
    markCompactionDirty(db, [a, b, c].map((id) => ({ id, scope: 'project', profile_id: profileId, persona_key: null, project_id: projectId, fingerprint: id === c ? null : 'fp-idem' })));
    const first = runMemoryHousekeeping(db, { force: true });
    expect(first.merged).toBe(1);
    expect(dirtyOf(c)).toBe(0); // 误报复位
    const second = runMemoryHousekeeping(db, { force: true });
    expect(second.merged).toBe(0); // 幂等
  });

  it('触发条件：无脏标记时不触发（不做全库扫）', () => {
    addEntry('普通内容');
    const result = runMemoryHousekeeping(db);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('not-triggered');
  });

  it('脏 ≥20 触发（不 force）', () => {
    for (let i = 0; i < 22; i++) {
      const id = addEntry(`内容${i}`, i % 2 === 0 ? 'fp-even' : null);
      db.prepare(`UPDATE memory_entry SET compaction_dirty=1 WHERE id=?`).run(id);
    }
    const result = runMemoryHousekeeping(db);
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('dirty>=20');
  });

  it('locked 条目永不 supersede', () => {
    const a = addEntry('锁定内容', 'fp-lock');
    const b = addEntry('普通内容', 'fp-lock');
    db.prepare(`UPDATE memory_entry SET state='locked' WHERE id=?`).run(a);
    db.prepare(`UPDATE memory_entry SET compaction_dirty=1 WHERE id IN (?,?)`).run(a, b);
    const result = runMemoryHousekeeping(db, { force: true });
    expect(result.merged).toBe(1);
    expect(stateOf(a)).toBe('locked');
    expect(stateOf(b)).toBe('superseded');
  });
});

describe('getMemoryHealth（健康度口径）', () => {
  it('总数/重复/命中率/上次压实可读', () => {
    addEntry('健康甲', 'fp-h1');
    addEntry('健康乙', 'fp-h1');
    const clean = addEntry('健康丙', 'fp-h2');
    db.prepare(`UPDATE memory_entry SET hit_count=3 WHERE id=?`).run(clean);
    markCompactionDirty(db, []);
    const health = getMemoryHealth(db);
    expect(health.activeEntries).toBe(3);
    expect(health.duplicatePairs).toBe(1);
    expect(health.hitRate).toBeCloseTo(1 / 3);
    expect(health.lastCompactionAt).toBeNull();
    expect(health.addedLast7d).toBe(3);
  });
});
