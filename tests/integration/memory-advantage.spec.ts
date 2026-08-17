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
import { assembleContext } from '../../src/server/executors/context';
import { getTask } from '../../src/server/domain/task';
import { appendTaskEvent } from '../../src/server/domain/task-event';
import {
  maybeTriggerAcceptanceReview,
  handleAcceptanceReviewTaskCompleted,
} from '../../src/server/domain/acceptance-review';

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

describe('生产接线与扫描过滤（review 修复回归）', () => {
  it('assembleContext 正常装配记账、lightweight 不注入不记账、不传 taskId 纯读', () => {
    const { c, p, lead } = seed();
    // 记忆必须挂在执行人（lead）自己的档案下，assembleContext 按 agent.profileId 加载
    const entry = seedProjectMemory(lead.profileId, c.id, p.id, '当前项目决定采用事件驱动架构');

    // 不传 taskId（旧调用方路径）：纯读，零记账
    const readOnly = loadContextMemories(db, {
      profileId: lead.profileId, companyId: c.id, projectId: p.id, query: '事件 驱动',
    });
    expect(readOnly.some((m) => m.id === entry)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_injection').get() as { n: number }).toEqual({ n: 0 });

    // 生产唯一调用点：assembleContext 带 task 上下文记账
    const task = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '继续实现事件模块' });
    const context = assembleContext(db, task);
    expect(context.systemPrompt).toContain('当前项目决定采用事件驱动架构');
    expect(getMemoryEntry(db, entry).hitCount).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_injection WHERE task_id=?').get(task.id) as { n: number })
      .toEqual({ n: 1 });

    // 轻量模式（咨询/讨论）：不注入记忆也不记账
    const lightTask = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '咨询一下事件模块' });
    assembleContext(db, lightTask, { lightweight: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_injection WHERE task_id=?').get(lightTask.id) as { n: number })
      .toEqual({ n: 0 });
    expect(getMemoryEntry(db, entry).hitCount).toBe(1);
  });

  it('扫描即过滤终态：永久 waiting/cancelled 不占结算窗口（防饥饿回归）', () => {
    const { profile, c, p, lead } = seed();
    const entry = seedProjectMemory(profile.id, c.id, p.id, '防饥饿经验');
    // 两个更早注入、但永远到不了可结算态的任务（修复前会占满 LIMIT 窗口饿死后来的终态任务）
    const stuck = createTask(db, { projectId: p.id, title: '半程', assigneeAgentId: lead.id });
    const cancelled = createTask(db, { projectId: p.id, title: '取消', assigneeAgentId: lead.id });
    inject(stuck.id, entry);
    inject(cancelled.id, entry);
    finishTask(stuck.id, 'waiting_input');
    finishTask(cancelled.id, 'cancelled');
    // 后来完成的任务：窗口收到最小 maxTasks=1 也必须能结算
    const done = createTask(db, { projectId: p.id, title: '完成', assigneeAgentId: lead.id });
    inject(done.id, entry);
    finishTask(done.id, 'completed');
    expect(settleMemoryVotes(db, { maxTasks: 1 })).toBe(1);
    // stuck/cancelled 的注入行保持未投票（语义正确），但不再挡路
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_injection WHERE voted_at IS NULL').get() as { n: number })
      .toEqual({ n: 2 });
  });

  it('验收未闭环推迟结算：返工计数落定后才投票（读到终值不漏记成本）', () => {
    const { profile, c, p, lead } = seed();
    const entry = seedProjectMemory(profile.id, c.id, p.id, '验收推迟经验');
    // 三个铺垫任务（每个返工 2 = 成本 4）→ 基线 4
    for (let i = 0; i < 3; i += 1) {
      const t = createTask(db, { projectId: p.id, title: '铺垫', assigneeAgentId: lead.id });
      inject(t.id, entry);
      finishTask(t.id, 'completed', 2, 0);
    }
    settleMemoryVotes(db);

    // 源任务带验收标准完成（此刻 rework_count=0）
    const source = createTask(db, {
      projectId: p.id, title: '带验收的活', assigneeAgentId: lead.id,
      acceptanceCriteria: [{ id: 'ac_1', criterion: '产物存在' }],
    });
    inject(source.id, entry);
    finishTask(source.id, 'completed');
    const review = maybeTriggerAcceptanceReview(db, getTask(db, source.id));
    expect(review).not.toBeNull();
    // 验收进行中（review 任务 queued = 活着）→ 推迟结算
    expect(settleMemoryVotes(db)).toBe(0);
    // 验收员判 FAIL：rework_count+1 先于 acceptance_rework 事件落库（acceptance-review.ts 顺序）
    db.prepare('UPDATE task SET summary=? WHERE id=?').run('VERDICT=FAIL\nCONFIDENCE=0.9\n不行重来', review!.id);
    handleAcceptanceReviewTaskCompleted(db, getTask(db, review!.id));
    expect(getTask(db, source.id).reworkCount).toBe(1);
    // 闭环后才结算，读到终值：成本 = 1×2 = 2 → 优势 = 4 − 2 = +2（修复前会读到成本 0 记 +4）
    expect(settleMemoryVotes(db)).toBe(1);
    expect(getMemoryEntry(db, entry).advSum).toBe(2);
  });

  it('验收任务死亡（失败）= 事后门放行：立即按当前终值结算', () => {
    const { profile, c, p, lead } = seed();
    const entry = seedProjectMemory(profile.id, c.id, p.id, '放行经验');
    const source = createTask(db, {
      projectId: p.id, title: '带验收的活', assigneeAgentId: lead.id,
      acceptanceCriteria: [{ id: 'ac_1', criterion: '产物存在' }],
    });
    inject(source.id, entry);
    finishTask(source.id, 'completed');
    const review = maybeTriggerAcceptanceReview(db, getTask(db, source.id));
    expect(review).not.toBeNull();
    finishTask(review!.id, 'failed'); // 验收任务自身失败：无闭环事件，源任务 rework_count 也不会再加
    expect(settleMemoryVotes(db)).toBe(1); // 不再推迟
  });

  it('有基线时 failed 仍投中性 0（低消耗失败不白捡正分）；成本高于基线记负优势', () => {
    const { profile, c, p, lead } = seed();
    const entry = seedProjectMemory(profile.id, c.id, p.id, '中性票经验');
    for (let i = 0; i < 3; i += 1) {
      const t = createTask(db, { projectId: p.id, title: '铺垫', assigneeAgentId: lead.id });
      inject(t.id, entry);
      finishTask(t.id, 'completed', 2, 0);
    }
    settleMemoryVotes(db); // 基线 4，entry 三条 0 票

    // 零消耗的失败任务：中性 0 票（若错误地按 completed 记票会白捡 4−0=+4）
    const failedTask = createTask(db, { projectId: p.id, title: '失败活', assigneeAgentId: lead.id });
    inject(failedTask.id, entry);
    finishTask(failedTask.id, 'failed', 0, 0);
    settleMemoryVotes(db);
    expect(getMemoryEntry(db, entry)).toMatchObject({ voteCount: 4, advSum: 0 });

    // 高于基线的完成任务（成本 6 > 基线 4）→ 负优势 −2（failed 不进基线，基线仍是 4）
    const heavy = createTask(db, { projectId: p.id, title: '折腾活', assigneeAgentId: lead.id });
    inject(heavy.id, entry);
    finishTask(heavy.id, 'completed', 3, 0);
    settleMemoryVotes(db);
    expect(getMemoryEntry(db, entry).advSum).toBe(-2);
  });

  it('闭环事件顺序锚点：appendTaskEvent 可作验收闭环信号（供扫描 SQL 消费）', () => {
    const { profile, c, p, lead } = seed();
    const entry = seedProjectMemory(profile.id, c.id, p.id, '闭环锚点经验');
    const source = createTask(db, {
      projectId: p.id, title: '带验收的活', assigneeAgentId: lead.id,
      acceptanceCriteria: [{ id: 'ac_1', criterion: '产物存在' }],
    });
    inject(source.id, entry);
    finishTask(source.id, 'completed');
    const review = maybeTriggerAcceptanceReview(db, getTask(db, source.id))!;
    expect(settleMemoryVotes(db)).toBe(0); // 推迟中
    appendTaskEvent(db, source.id, 'acceptance_passed', { reviewTaskId: review.id });
    expect(settleMemoryVotes(db)).toBe(1); // 闭环事件即放行
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
    // 先断言在场，防 indexOf(-1) 让比较空过
    expect(ids).toEqual(expect.arrayContaining([stable, lucky, fresh]));
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
    expect(ids).toEqual(expect.arrayContaining([newer, older]));
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
  });
});
