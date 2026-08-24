/**
 * 记忆更新闭环（P1-①）+ 写入/注入配额（P0-②）+ personal 注入上限（P0-③ 第一道闸）。
 * 对标文档记忆机制的学习循环"更新"环节：superseded 状态从死码激活为结构化替代语义。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgentProfile } from '../../src/server/domain/agent-profile';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import {
  applySupersede,
  approveMemoryCandidate,
  createMemoryCandidate,
  getMemoryEntry,
  loadContextMemories,
  MEMORY_CONTENT_MAX_CHARS,
  MEMORY_INJECT_PERSONAL_MAX_ENTRIES,
  searchMemory,
} from '../../src/server/domain/memory';
import { makeTestDb } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

describe('记忆更新闭环（superseded）', () => {
  it('批准替代候选：旧条目转 superseded、清 FTS、新条目继承战绩、注入不再含旧条目', () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    const workbench = restoreWorkbench(db, { id: 'wb_sup_1', name: '工作台' });
    const project = createProject(db, { companyId: workbench.id, name: '项目' });

    // 旧记忆：批准后人为累计战绩（模拟历史投票）
    const oldCandidate = createMemoryCandidate(db, {
      profileId: profile.id, scope: 'project', projectId: project.id,
      content: '部署用 rsync 全量同步', author: 'agent', confidence: 0.9, canInfluence: true, allowAutoApprove: true,
    });
    const oldEntry = db.prepare('SELECT id FROM memory_entry WHERE source_candidate_id=?').get(oldCandidate.id) as { id: string };
    db.prepare('UPDATE memory_entry SET hit_count=10, vote_count=4, adv_sum=8 WHERE id=?').run(oldEntry.id);

    // 新候选声明替代旧条目
    const replacement = createMemoryCandidate(db, {
      profileId: profile.id, scope: 'project', projectId: project.id,
      content: '部署改为 rsync 增量同步（--link-dest），全量已过时', author: 'agent', confidence: 0.9,
      canInfluence: true, allowAutoApprove: true, supersedesEntryId: oldEntry.id,
    });
    expect(replacement.supersedesEntryId).toBe(oldEntry.id);
    expect(replacement.status).toBe('approved'); // project scope 高置信自动批准 → 替代立即生效

    // 旧条目退场：superseded + FTS 清除
    expect(getMemoryEntry(db, oldEntry.id).state).toBe('superseded');
    const ftsHit = db.prepare('SELECT COUNT(*) AS c FROM memory_fts WHERE entry_id=?').get(oldEntry.id) as { c: number };
    expect(ftsHit.c).toBe(0);

    // 新条目继承战绩（hit 10 / vote 4 / adv 8 从零继承）
    const newEntry = db.prepare('SELECT * FROM memory_entry WHERE source_candidate_id=?').get(replacement.id) as { hit_count: number; vote_count: number; adv_sum: number; state: string };
    expect(newEntry.state).toBe('active');
    expect(newEntry.hit_count).toBe(10);
    expect(newEntry.vote_count).toBe(4);
    expect(newEntry.adv_sum).toBe(8);

    // 注入与检索都不再看到旧条目
    const injected = loadContextMemories(db, { profileId: profile.id, projectId: project.id, query: '部署同步' });
    expect(injected.some((e) => e.id === oldEntry.id)).toBe(false);
    expect(injected.some((e) => e.id === newEntry.id)).toBe(true);
    const searched = searchMemory(db, { profileId: profile.id, projectId: project.id, query: 'rsync' });
    expect(searched.some((e) => e.id === oldEntry.id)).toBe(false);
  });

  it('替代目标不合法（幻觉 id / 跨 scope）时静默降级为普通候选', () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    const degraded = createMemoryCandidate(db, {
      profileId: profile.id, scope: 'personal',
      content: '偏好简体中文回复', author: 'user', confidence: 1, canInfluence: true,
      supersedesEntryId: 'me_does_not_exist',
    });
    expect(degraded.supersedesEntryId).toBeNull();
    expect(degraded.status).toBe('pending');

    // 跨 scope 目标同样降级
    const other = createAgentProfile(db, { displayName: '他人' });
    const otherCandidate = createMemoryCandidate(db, {
      profileId: other.id, scope: 'personal', content: '他人的偏好', author: 'user', confidence: 1, canInfluence: true, allowAutoApprove: true,
    });
    const otherEntry = db.prepare('SELECT id FROM memory_entry WHERE source_candidate_id=?').get(otherCandidate.id) as { id: string };
    const crossScope = createMemoryCandidate(db, {
      profileId: profile.id, scope: 'personal', content: '新的偏好', author: 'user', confidence: 1, canInfluence: true,
      supersedesEntryId: otherEntry.id, // 目标是别人的 personal 条目——跨 profile 拒绝
    });
    expect(crossScope.supersedesEntryId).toBeNull();
  });

  it('applySupersede 批量替代（个人偏好合并提案用）：多对一继承合计战绩、幂等跳过已退场条目', () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    const ids: string[] = [];
    for (const content of ['【风格】要正式', '【风格】要简洁', '【风格】少用表情']) {
      const candidate = createMemoryCandidate(db, {
        profileId: profile.id, scope: 'personal', content, author: 'user', confidence: 1, canInfluence: true, allowAutoApprove: true,
      });
      const entry = db.prepare('SELECT id FROM memory_entry WHERE source_candidate_id=?').get(candidate.id) as { id: string };
      ids.push(entry.id);
    }
    db.prepare('UPDATE memory_entry SET hit_count=3, vote_count=1, adv_sum=2 WHERE id IN (?, ?, ?)').run(...ids);

    const mergedCandidate = createMemoryCandidate(db, {
      profileId: profile.id, scope: 'personal', content: '【风格】正式但简洁，避免表情符号', author: 'user', confidence: 1, canInfluence: true,
    });
    const merged = approveMemoryCandidate(db, mergedCandidate.id, 'user');

    const count = applySupersede(db, ids, merged.id, 'user');
    expect(count).toBe(3);
    for (const id of ids) expect(getMemoryEntry(db, id).state).toBe('superseded');
    const after = getMemoryEntry(db, merged.id);
    expect(after.hitCount).toBe(9);
    expect(after.voteCount).toBe(3);
    expect(after.advSum).toBe(6);

    // 幂等：再次执行对已退场条目零效果
    expect(applySupersede(db, ids, merged.id, 'user')).toBe(0);
    expect(getMemoryEntry(db, merged.id).hitCount).toBe(9);
  });
});

describe('写入与注入配额（P0-②/P0-③）', () => {
  it('content 硬 cap：超长记忆截断并标记', () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    const long = '长'.repeat(MEMORY_CONTENT_MAX_CHARS + 500);
    const candidate = createMemoryCandidate(db, {
      profileId: profile.id, scope: 'personal', content: long, author: 'user', confidence: 1, canInfluence: true,
    });
    expect(candidate.content.length).toBe(MEMORY_CONTENT_MAX_CHARS); // Review P2-5：截断后严格 ≤ cap（含标记）
    expect(candidate.content.endsWith('…（已截断）')).toBe(true);
  });

  it('注入字符预算：personal 与其余段各自限额，按排序保序截断', () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    const workbench = restoreWorkbench(db, { id: 'wb_budget', name: '工作台' });
    const project = createProject(db, { companyId: workbench.id, name: '项目' });
    // personal：2 条 ×1500 字 = 3000 字 > 2000 预算 → 只注入第 1 条
    for (const text of ['偏'.repeat(1500), '好'.repeat(1500)]) {
      createMemoryCandidate(db, { profileId: profile.id, scope: 'personal', content: text, author: 'user', confidence: 1, canInfluence: true, allowAutoApprove: true });
    }
    // project：3 条 ×1500 字 = 4500 字 > 4000 预算 → 只注入前 2 条
    for (const text of ['甲'.repeat(1500), '乙'.repeat(1500), '丙'.repeat(1500)]) {
      createMemoryCandidate(db, { profileId: profile.id, scope: 'project', projectId: project.id, content: text, author: 'agent', confidence: 0.9, canInfluence: true, allowAutoApprove: true });
    }
    const injected = loadContextMemories(db, { profileId: profile.id, projectId: project.id });
    const personal = injected.filter((e) => e.scope === 'personal');
    const rest = injected.filter((e) => e.scope !== 'personal');
    expect(personal).toHaveLength(1);
    expect(rest).toHaveLength(2);
  });

  it('personal 注入条数上限：超限条目出列且不记账', () => {
    const profile = createAgentProfile(db, { displayName: '员工' });
    const workbench = restoreWorkbench(db, { id: 'wb_cap', name: '工作台' });
    const project = createProject(db, { companyId: workbench.id, name: '项目' });
    const total = MEMORY_INJECT_PERSONAL_MAX_ENTRIES + 5;
    for (let i = 0; i < total; i++) {
      createMemoryCandidate(db, {
        profileId: profile.id, scope: 'personal', content: `偏好 ${i}：保持简短`,
        author: 'user', confidence: 1, canInfluence: true, allowAutoApprove: true,
      });
    }
    // 默认 LIMIT 8 会先截断，传大 limit 让 personal 专属上限（12）成为约束边界
    const injected = loadContextMemories(db, { profileId: profile.id, projectId: project.id, taskId: 'tk_budget_1', limit: 20 });
    expect(injected.filter((e) => e.scope === 'personal').length).toBeLessThanOrEqual(MEMORY_INJECT_PERSONAL_MAX_ENTRIES);
    expect(injected).toHaveLength(MEMORY_INJECT_PERSONAL_MAX_ENTRIES); // 库里只有 personal
  });
});
