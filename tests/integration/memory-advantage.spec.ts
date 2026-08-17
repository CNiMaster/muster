/**
 * 记忆优势分：注入记账 + 终态结算 + 排序升级（集成测试）。
 *
 * 验证整条回路：loadContextMemories 带 taskId 记账（personal 豁免、幂等）→
 * settleMemoryVotes 终态结算（基线/消耗/失败中性/恰好一次）→
 * 收缩平均优势排序（老而准稳压新而平庸、零票走时间序）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { createAgentProfile } from '../../src/server/domain/agent-profile';
import {
  createMemoryCandidate,
  getMemoryEntry,
  loadContextMemories,
  settleMemoryVotes,
} from '../../src/server/domain/memory';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
});

/** 标准 active 项目 + lead 员工 + 档案。 */
function seed() {
  const profile = createAgentProfile(db, { displayName: '员工' });
  const c = createCompany(db, { name: '优势公司' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { profile, c, lead, p };
}

/** 造一条已批准的项目记忆（高置信自动批准），返回 entry id（自动批准后 entry 是新 id）。 */
function seedProjectMemory(profileId: string, companyId: string, projectId: string, content: string): string {
  const candidate = createMemoryCandidate(db, {
    profileId,
    scope: 'project',
    companyId,
    projectId,
    content,
    author: 'agent',
    confidence: 0.9,
    canInfluence: true,
    allowAutoApprove: true,
  });
  const entry = db.prepare('SELECT id FROM memory_entry WHERE source_candidate_id=?')
    .get(candidate.id) as { id: string } | undefined;
  if (!entry) throw new Error('project 记忆自动批准失败');
  return entry.id;
}

/** 直接摆任务终态与消耗（绕过状态机，聚焦结算逻辑本身）。 */
function finishTask(taskId: string, state: string, rework = 0, clarify = 0): void {
  db.prepare('UPDATE task SET state=?, rework_count=?, clarification_rounds=? WHERE id=?')
    .run(state, rework, clarify, taskId);
}

/** 直接记注入行（结算测试精确控制"谁参与了本任务"，避开词元命中的归因噪音）。 */
function inject(taskId: string, ...entryIds: string[]): void {
  const insert = db.prepare('INSERT INTO memory_injection (task_id, entry_id, injected_at) VALUES (?, ?, ?)');
  for (const entryId of entryIds) insert.run(taskId, entryId, new Date().toISOString());
}

describe('注入记账（loadContextMemories + taskId）', () => {
  it('personal 豁免不记账；非 personal 记 hit_count + memory_injection', () => {
    const { profile, c, p, lead } = seed();
    // personal：author=user 自动批准
    createMemoryCandidate(db, {
      profileId: profile.id, scope: 'personal', content: '用户偏好用中文回复',
      author: 'user', confidence: 1, canInfluence: true, allowAutoApprove: true,
    });
    const projectEntryId = seedProjectMemory(profile.id, c.id, p.id, '特性：本方案用 SQLite 存储');
    const task = createTask(db, { projectId: p.id, title: '特性：实现存储', assigneeAgentId: lead.id });

    const memories = loadContextMemories(db, {
      profileId: profile.id, companyId: c.id, projectId: p.id,
      query: '特性 存储', taskId: task.id,
    });
    // personal 照常注入（user 偏好永远全量），但只记非 personal 的账
    expect(memories.some((m) => m.scope === 'personal')).toBe(true);
    const personalEntry = getMemoryEntry(db, memories.find((m) => m.scope === 'personal')!.id);
    expect(personalEntry.hitCount).toBe(0);
    const projectEntry = getMemoryEntry(db, projectEntryId);
    expect(projectEntry.hitCount).toBe(1);
    expect(projectEntry.voteCount).toBe(0);
    const injection = db.prepare('SELECT * FROM memory_injection WHERE task_id=? AND entry_id=?')
      .get(task.id, projectEntryId) as { voted_at: string | null } | undefined;
    expect(injection).toBeDefined();
    expect(injection!.voted_at).toBeNull();
    // personal 无注入行
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_injection WHERE entry_id=?')
      .get(personalEntry.id) as { n: number }).toEqual({ n: 0 });
  });

  it('waiting_input 恢复后重装配不重复计数（(task, entry) 幂等）；后轮新命中补记', () => {
    const { profile, c, p, lead } = seed();
    const entryA = seedProjectMemory(profile.id, c.id, p.id, '特性：第一次装配就命中');
    const task = createTask(db, { projectId: p.id, title: '特性：恢复任务', assigneeAgentId: lead.id });

    loadContextMemories(db, {
      profileId: profile.id, companyId: c.id, projectId: p.id,
      query: '特性 装配', taskId: task.id,
    });
    // 第二轮装配（waiting_input 恢复后重 claim）：同一条记忆不再重复计数
    loadContextMemories(db, {
      profileId: profile.id, companyId: c.id, projectId: p.id,
      query: '特性 装配', taskId: task.id,
    });
    expect(getMemoryEntry(db, entryA).hitCount).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_injection WHERE task_id=?').get(task.id) as { n: number })
      .toEqual({ n: 1 });

    // 第三轮装配时出现了新的命中记忆 → 补记
    const entryB = seedProjectMemory(profile.id, c.id, p.id, '特性：后来才沉淀的经验');
    loadContextMemories(db, {
      profileId: profile.id, companyId: c.id, projectId: p.id,
      query: '特性 沉淀', taskId: task.id,
    });
    expect(getMemoryEntry(db, entryA).hitCount).toBe(1);
    expect(getMemoryEntry(db, entryB).hitCount).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_injection WHERE task_id=?').get(task.id) as { n: number })
      .toEqual({ n: 2 });
  });
});

describe('终态结算（settleMemoryVotes）', () => {
  it('冷启动：样本不足 3 时优势记 0；基线启用后按「基线 − 消耗」记票', () => {
    const { profile, c, p, lead } = seed();
    const entryA = seedProjectMemory(profile.id, c.id, p.id, '特性：老而准的经验');
    const entryB = seedProjectMemory(profile.id, c.id, p.id, '特性：另一条经验');

    // 前三个任务（只注入 entryA）：无基线 → 优势 0，仅累计项目基线
    for (const [rework, clarify] of [[0, 0], [1, 1], [1, 1]] as const) {
      const task = createTask(db, { projectId: p.id, title: '铺垫', assigneeAgentId: lead.id });
      inject(task.id, entryA);
      finishTask(task.id, 'completed', rework, clarify);
    }
    settleMemoryVotes(db);
    // 三条 0 票；entryB 未参与
    expect(getMemoryEntry(db, entryA)).toMatchObject({ voteCount: 3, advSum: 0 });
    expect(getMemoryEntry(db, entryB).voteCount).toBe(0);
    // 基线累计：成本 0 + (1×2+1) + (1×2+1) = 0 + 3 + 3 = 6，3 个样本 → 基线 2
    const stat = db.prepare('SELECT task_count, cost_sum FROM project_cost_stat WHERE project_id=?').get(p.id) as
      { task_count: number; cost_sum: number };
    expect(stat).toEqual({ task_count: 3, cost_sum: 6 });

    // 第四个任务零返工零追问 → 优势 = 2 − 0 = +2
    const task4 = createTask(db, { projectId: p.id, title: '顺风任务', assigneeAgentId: lead.id });
    inject(task4.id, entryA);
    finishTask(task4.id, 'completed');
    settleMemoryVotes(db);
    expect(getMemoryEntry(db, entryA)).toMatchObject({ voteCount: 4, advSum: 2 });
  });

  it('硬任务公平性：高基线下返工一次仍是正优势（不冤枉难项目）', () => {
    const { profile, c, p, lead } = seed();
    const entry = seedProjectMemory(profile.id, c.id, p.id, '硬项目经验');
    // 三个高消耗铺垫任务（每个返工 2 次 = 成本 4）→ 基线 4
    for (let i = 0; i < 3; i += 1) {
      const task = createTask(db, { projectId: p.id, title: '难活', assigneeAgentId: lead.id });
      inject(task.id, entry);
      finishTask(task.id, 'completed', 2, 0);
    }
    settleMemoryVotes(db);
    // 本任务返工 1 次 = 成本 2 < 基线 4 → +2
    const task = createTask(db, { projectId: p.id, title: '稍好的活', assigneeAgentId: lead.id });
    inject(task.id, entry);
    finishTask(task.id, 'completed', 1, 0);
    settleMemoryVotes(db);
    expect(getMemoryEntry(db, entry)).toMatchObject({ voteCount: 4, advSum: 2 });
  });

  it('failed 投中性 0 票且不计入基线；cancelled/waiting_input 不投', () => {
    const { profile, c, p, lead } = seed();
    const entry = seedProjectMemory(profile.id, c.id, p.id, '故障项目经验');
    const task = createTask(db, { projectId: p.id, title: '失败活', assigneeAgentId: lead.id });
    inject(task.id, entry);
    finishTask(task.id, 'failed', 3, 2);
    expect(settleMemoryVotes(db)).toBe(1);
    // 票投了但中性：voteCount+1、advSum 不动
    expect(getMemoryEntry(db, entry)).toMatchObject({ voteCount: 1, advSum: 0 });
    // failed 不产生基线（基线 = 正常完成水平）
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_cost_stat WHERE project_id=?').get(p.id) as { n: number })
      .toEqual({ n: 0 });

    // cancelled / waiting_input：未终态，不投
    const cancelled = createTask(db, { projectId: p.id, title: '取消活', assigneeAgentId: lead.id });
    const waiting = createTask(db, { projectId: p.id, title: '半程活', assigneeAgentId: lead.id });
    inject(cancelled.id, entry);
    inject(waiting.id, entry);
    finishTask(cancelled.id, 'cancelled');
    finishTask(waiting.id, 'waiting_input');
    expect(settleMemoryVotes(db)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_injection WHERE voted_at IS NULL').get() as { n: number })
      .toEqual({ n: 2 });
  });

  it('恰好一次：重复结算不重复计票（voted_at 守卫，断电重扫安全）', () => {
    const { profile, c, p, lead } = seed();
    const entry = seedProjectMemory(profile.id, c.id, p.id, '唯一经验');
    const task = createTask(db, { projectId: p.id, title: '结算活', assigneeAgentId: lead.id });
    inject(task.id, entry);
    finishTask(task.id, 'completed');
    expect(settleMemoryVotes(db)).toBe(1);
    expect(settleMemoryVotes(db)).toBe(0); // 第二次无待结算
    expect(getMemoryEntry(db, entry)).toMatchObject({ voteCount: 1, advSum: 0 });
    expect(db.prepare('SELECT task_count, cost_sum FROM project_cost_stat WHERE project_id=?').get(p.id))
      .toEqual({ task_count: 1, cost_sum: 0 });
  });
});

describe('排序（收缩平均优势优先，时间序兜底）', () => {
  it('长期稳定正优势压过短期侥幸；零票新记忆按时间序保底出场', () => {
    const { profile, c, p, lead } = seed();
    // 同 scope 三条记忆，content 都含「特性」词元
    const stable = seedProjectMemory(profile.id, c.id, p.id, '特性：五十次出战的稳定经验');
    const lucky = seedProjectMemory(profile.id, c.id, p.id, '特性：两次侥幸的经验');
    const fresh = seedProjectMemory(profile.id, c.id, p.id, '特性：刚沉淀的新经验');
    // 直接摆战绩：stable 50 票 adv 20（20/55≈0.364）；lucky 2 票 adv 2（2/7≈0.286）
    db.prepare('UPDATE memory_entry SET vote_count=50, adv_sum=20 WHERE id=?').run(stable);
    db.prepare('UPDATE memory_entry SET vote_count=2, adv_sum=2 WHERE id=?').run(lucky);

    const memories = loadContextMemories(db, {
      profileId: profile.id, companyId: c.id, projectId: p.id,
      query: '特性',
    });
    const ids = memories.filter((m) => m.scope === 'project').map((m) => m.id);
    expect(ids.indexOf(stable)).toBeLessThan(ids.indexOf(lucky));
    expect(ids.indexOf(lucky)).toBeLessThan(ids.indexOf(fresh));
  });

  it('零票记忆之间仍按时间序（新记忆有探索出场权）', () => {
    const { profile, c, p, lead } = seed();
    const older = seedProjectMemory(profile.id, c.id, p.id, '特性：旧经验');
    const newer = seedProjectMemory(profile.id, c.id, p.id, '特性：新经验');
    // 显式拉开时间戳（同毫秒创建的 updated_at 会相等，避免测试依赖时钟运气）
    db.prepare("UPDATE memory_entry SET updated_at=? WHERE id=?").run('2026-08-17T02:00:00.000Z', older);
    db.prepare("UPDATE memory_entry SET updated_at=? WHERE id=?").run('2026-08-17T02:00:01.000Z', newer);
    const memories = loadContextMemories(db, {
      profileId: profile.id, companyId: c.id, projectId: p.id,
      query: '特性',
    });
    const ids = memories.filter((m) => m.scope === 'project').map((m) => m.id);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
  });
});
