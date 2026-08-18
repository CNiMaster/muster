import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 员工评级测试：计算（任务完成/记忆/外包验收加权）/ 手动调整 / 阈值映射 / 接入点。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, type Task } from '../../src/server/domain/task';
import {
  calculateRating,
  applyRating,
  adjustRating,
  recalculateAllRatings,
} from '../../src/server/domain/employee-rating';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;
let projectId: string;
let agentId: string;
let profileId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  companyId = restoreWorkbench(db, { id: 'wb_fix_1', name: '评级公司' }).id;
  const agent = createAgent(db, {
    companyId,
    name: '被评员工',
    role: 'lead',
    systemPrompt: '',
    skills: [],
    tools: [],
    permissions: {},
    executor: {},
  });
  agentId = agent.id;
  profileId = agent.profileId;
  db.prepare("UPDATE workbench SET state='online', first_agent_id=? WHERE id=?").run(agentId, companyId);
  projectId = createProject(db, { companyId, name: '项目', initialState: 'active' }).id;
});

afterEach(() => tdb.close());

/** 标记若干任务为 completed（assignee = 测试员工）。 */
function completeTasks(n: number): void {
  for (let i = 0; i < n; i++) {
    const t = createTask(db, { projectId, title: `任务${i}`, assigneeAgentId: agentId });
    db.prepare("UPDATE task SET state='completed' WHERE id=?").run(t.id);
  }
}

describe('评级计算', () => {
  it('初始评级 1 星（无任何业绩）', () => {
    const r = calculateRating(db, profileId);
    expect(r.stars).toBe(1);
    expect(r.completedTasks).toBe(0);
  });

  it('完成任务提升星级', () => {
    completeTasks(3);
    const r = calculateRating(db, profileId);
    expect(r.completedTasks).toBe(3);
    expect(r.score).toBe(3); // 3 任务 × 1 = 3
    expect(r.stars).toBeGreaterThanOrEqual(2); // score=3 → 2 星
  });

  it('大量任务达到高星级', () => {
    completeTasks(25);
    const r = calculateRating(db, profileId);
    expect(r.stars).toBe(5);
  });

  it('记忆条数也计入 score', () => {
    // 插入记忆条目（绕过审核，直接写 memory_entry）
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO memory_entry (id, profile_id, scope, content, version, state, created_at, updated_at)
         VALUES (?,?,'personal',?,1,'active',?,?)`,
      ).run(`me_${i}`, profileId, `记忆${i}`, now, now);
    }
    const r = calculateRating(db, profileId);
    expect(r.memoryEntries).toBe(10);
    expect(r.score).toBe(5); // 10 × 0.5 = 5
    expect(r.stars).toBe(2); // score=5 < 阈值8 → 2 星
  });
});

describe('applyRating 写回', () => {
  it('计算并写回 agent_profile.rating', () => {
    completeTasks(8);
    const stars = applyRating(db, profileId);
    const row = db.prepare('SELECT rating FROM agent_profile WHERE id=?').get(profileId) as { rating: number };
    expect(row.rating).toBe(stars);
    expect(row.rating).toBeGreaterThanOrEqual(3);
  });
});

describe('adjustRating 手动调整', () => {
  it('用户手动设为 5 星', () => {
    adjustRating(db, profileId, 5);
    const row = db.prepare('SELECT rating FROM agent_profile WHERE id=?').get(profileId) as { rating: number };
    expect(row.rating).toBe(5);
  });

  it('越界报错', () => {
    expect(() => adjustRating(db, profileId, 0)).toThrow();
    expect(() => adjustRating(db, profileId, 6)).toThrow();
  });
});

describe('recalculateAllRatings 批量重算', () => {
  it('重算所有 profile', () => {
    completeTasks(5);
    const count = recalculateAllRatings(db);
    expect(count).toBeGreaterThanOrEqual(1);
    const row = db.prepare('SELECT rating FROM agent_profile WHERE id=?').get(profileId) as { rating: number };
    expect(row.rating).toBeGreaterThanOrEqual(2);
  });
});
