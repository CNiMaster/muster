/**
 * B2 三档广深 集成测试。
 *
 * 验证：
 * - 常量表：轻/中/重三档的槽位/蜂群三限/验收轮次/讨论轮次。
 * - clampSwarmLimits：min(全局/覆盖额度, 档位)；预算不钳；专家自主额度与档位取交集。
 * - materializeSwarm：建群快照按源任务档位钳制；蜂任务继承 breadthTier。
 * - 验收返工轮次随档位（轻=1 轮即升级；返工任务继承档位）。
 * - 工作台默认档设置生效（任务未声明档位时回落 breadth_default_tier）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { restoreWorkbench, updateWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, completeTask } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { materializeSwarm, getSwarmRun, EXPERT_SWARM_LIMITS, type SwarmPlan } from '../../src/server/domain/swarm';
import { maybeTriggerAcceptanceReview, handleAcceptanceReviewTaskCompleted } from '../../src/server/domain/acceptance-review';
import {
  BREADTH_LIMITS,
  clampSwarmLimits,
  taskBreadthTier,
  breadthLimits,
} from '../../src/server/domain/breadth-tier';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

function seed() {
  const c = restoreWorkbench(db, { id: 'wb_breadth_1', name: '公司' });
  const lead = createAgent(db, { companyId: c.id, name: '干员', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir: '/tmp/breadth', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

function running(taskId: string): void {
  db.prepare("UPDATE task SET state='running' WHERE id=?").run(taskId);
}

const PLAN2: SwarmPlan = {
  goal: '调研两个主题',
  workers: [
    { title: '子题一', brief: '查 A' },
    { title: '子题二', brief: '查 B' },
  ],
};

describe('常量表与纯函数', () => {
  it('三档常量符合定版表', () => {
    expect(BREADTH_LIMITS.light).toEqual({ crewSlots: 1, swarmMaxDepth: 1, swarmMaxWidth: 3, swarmMaxNodes: 4, acceptanceReworkRounds: 1, discussionMaxTurns: 6 });
    expect(BREADTH_LIMITS.standard.swarmMaxWidth).toBe(5);
    expect(BREADTH_LIMITS.heavy).toEqual({ crewSlots: 4, swarmMaxDepth: 3, swarmMaxWidth: 8, swarmMaxNodes: 30, acceptanceReworkRounds: 3, discussionMaxTurns: 20 });
  });

  it('clampSwarmLimits：全局仍是天花板（取 min）；预算不钳', () => {
    // 全局更紧 → 取全局
    expect(clampSwarmLimits({ maxDepth: 3, maxWidth: 2, maxNodes: 30, budgetUsd: 5 }, 'heavy'))
      .toEqual({ maxDepth: 3, maxWidth: 2, maxNodes: 30, budgetUsd: 5 });
    // 档位更紧 → 取档位
    expect(clampSwarmLimits({ maxDepth: 3, maxWidth: 5, maxNodes: 30, budgetUsd: 5 }, 'light'))
      .toEqual({ maxDepth: 1, maxWidth: 3, maxNodes: 4, budgetUsd: 5 });
    // 专家自主额度（1/3/4）与 light（1/3/4）取交集不变
    expect(clampSwarmLimits(EXPERT_SWARM_LIMITS, 'light')).toEqual({ ...EXPERT_SWARM_LIMITS, budgetUsd: 1 });
  });

  it('工作台默认档设置生效；任务级声明覆盖', () => {
    const { lead, p } = seed();
    // 默认 standard
    expect(taskBreadthTier(db, undefined)).toBe('standard');
    expect(breadthLimits(taskBreadthTier(db, undefined)).tier).toBe('standard');
    // 设置默认档为 light → 未声明任务回落 light
    updateWorkbench(db, {});
    db.prepare("INSERT INTO system_setting (key, value, updated_at) VALUES ('breadth_default_tier', 'light', '2026-01-01T00:00:00Z') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    expect(taskBreadthTier(db, undefined)).toBe('light');
    // 任务级声明优先
    expect(taskBreadthTier(db, { breadthTier: 'heavy' })).toBe('heavy');
    // 非法值回落默认档
    expect(taskBreadthTier(db, { breadthTier: 'mega' })).toBe('light');
    void lead; void p;
  });
});

describe('materializeSwarm 档位钳制与蜂继承', () => {
  it('轻档任务建群：快照按档位钳制；蜂继承 breadthTier', () => {
    const { lead, p } = seed();
    const root = createTask(db, {
      projectId: p.id, assigneeAgentId: lead.id, title: '轻档调研',
      inputProtocol: { breadthTier: 'light' },
    });
    running(root.id);
    const { swarmId } = materializeSwarm(db, root, PLAN2, { requesterAgentId: lead.id });
    const run = getSwarmRun(db, swarmId);
    // 全局默认 3/5/30 与 light 1/3/4 取 min → 1/3/4
    expect(run.maxDepth).toBe(1);
    expect(run.maxWidth).toBe(3);
    expect(run.maxNodes).toBe(4);
    expect(run.budgetUsd).toBe(5); // 预算不钳
    // 蜂任务继承档位
    const bee = db.prepare(
      "SELECT input_protocol_json FROM task WHERE swarm_id=? AND title='子题一' LIMIT 1",
    ).get(swarmId) as { input_protocol_json: string } | undefined;
    expect(bee).toBeDefined();
    const proto = JSON.parse(bee!.input_protocol_json) as Record<string, unknown>;
    expect(proto.breadthTier).toBe('light');
  });

  it('未声明档位：默认 standard（快照 2/5/12）', () => {
    const { lead, p } = seed();
    const root = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '默认档调研' });
    running(root.id);
    const { swarmId } = materializeSwarm(db, root, PLAN2, { requesterAgentId: lead.id });
    const run = getSwarmRun(db, swarmId);
    expect(run.maxDepth).toBe(2);
    expect(run.maxWidth).toBe(5);
    expect(run.maxNodes).toBe(12);
  });
});

describe('验收返工轮次随档位', () => {
  it('轻档：1 轮返工后第二次 FAIL 升级用户（不再派第二轮返工）', () => {
    const { lead, p } = seed();
    const source = createTask(db, {
      projectId: p.id, assigneeAgentId: lead.id, title: '轻档任务',
      acceptanceCriteria: [{ id: 'ac_1', criterion: '产物存在' }],
      inputProtocol: { breadthTier: 'light' },
    });
    // 第 1 轮 FAIL → 返工 R1（reviewRound=1，仍在轻档上限内）
    let review = maybeTriggerAcceptanceReview(db, source)!;
    running(review.id);
    completeTask(db, review.id, { outcome: 'completed', summary: 'VERDICT=FAIL\nCONFIDENCE=0.9\n不达标', outboundTasks: [], artifacts: [] });
    handleAcceptanceReviewTaskCompleted(db, getTask(db, review.id));
    const reworkId = (db.prepare("SELECT id FROM task WHERE input_protocol_json LIKE '%\"type\":\"business_rework\"%' ORDER BY seq DESC LIMIT 1").get() as { id: string }).id;
    const rework = getTask(db, reworkId);
    expect((rework.inputProtocol as Record<string, unknown>).breadthTier).toBe('light'); // 返工继承档位

    // R1 完成 → 再 FAIL → 轻档上限 1 已到 → 升级用户，不再派 R2
    running(reworkId);
    completeTask(db, reworkId, { outcome: 'completed', summary: '返工产出', outboundTasks: [], artifacts: [] });
    review = maybeTriggerAcceptanceReview(db, getTask(db, reworkId))!;
    running(review.id);
    completeTask(db, review.id, { outcome: 'completed', summary: 'VERDICT=FAIL\nCONFIDENCE=0.9\n仍不达标', outboundTasks: [], artifacts: [] });
    handleAcceptanceReviewTaskCompleted(db, getTask(db, review.id));
    const rounds = db.prepare("SELECT COUNT(*) AS n FROM task WHERE input_protocol_json LIKE '%\"type\":\"business_rework\"%'").get() as { n: number };
    expect(rounds.n).toBe(1); // 只有 R1
    expect(listTaskEvents(db, reworkId).some((e) => e.kind === 'acceptance_escalated')).toBe(true);
  });

  it('重档：3 轮返工链完整（heavy 上限）', () => {
    const { lead, p } = seed();
    const source = createTask(db, {
      projectId: p.id, assigneeAgentId: lead.id, title: '重档任务',
      acceptanceCriteria: [{ id: 'ac_1', criterion: '产物存在' }],
      inputProtocol: { breadthTier: 'heavy' },
    });
    let currentId = source.id;
    for (let round = 1; round <= 3; round++) {
      const review = maybeTriggerAcceptanceReview(db, getTask(db, currentId))!;
      running(review.id);
      completeTask(db, review.id, { outcome: 'completed', summary: `VERDICT=FAIL\nCONFIDENCE=0.9\n第${round}轮不达标`, outboundTasks: [], artifacts: [] });
      handleAcceptanceReviewTaskCompleted(db, getTask(db, review.id));
      const reworkId = (db.prepare("SELECT id FROM task WHERE input_protocol_json LIKE '%\"type\":\"business_rework\"%' ORDER BY seq DESC LIMIT 1").get() as { id: string }).id;
      currentId = reworkId;
      running(reworkId);
      completeTask(db, reworkId, { outcome: 'completed', summary: `第${round}轮返工产出`, outboundTasks: [], artifacts: [] });
    }
    const rounds = db.prepare("SELECT COUNT(*) AS n FROM task WHERE input_protocol_json LIKE '%\"type\":\"business_rework\"%'").get() as { n: number };
    expect(rounds.n).toBe(3); // heavy 上限 3 轮全派
  });
});
