import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 专家链路修复（WP1）+ 模型档位（WP9）集成测试。
 *
 * 验证：
 * - 豁免蓝图穿戴：exemptBlueprintMatch=true 的任务不被 matchBlueprint 自动穿人设（验收/返工防串立场）。
 * - 蓝图工具读侧消费：命中蓝图时 tools 记账进入 inputProtocol.blueprintTools。
 * - persona_miss 留痕：蜂群 worker 指定库外人设 → 根任务留事件 + 蜂降级匿名。
 * - 人设库索引：listPersonaIndex 域分组、条目结构完整（养蜂人可见目录）。
 * - 模型档位：modelTierForTask 判定（工蜂/辩手=轻量；计划/验收/裁决/请示=高级）+ 设置键往返。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { createTask, getTask, type Task } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { evolveBlueprint } from '../../src/server/domain/blueprint';
import { listPersonaIndex, listPersonas } from '../../src/server/domain/persona-library';
import { materializeSwarm } from '../../src/server/domain/swarm';
import { ensureDispatcherAgentId } from '../../src/server/domain/system-agents';
import { getSystemSettings, saveSystemSettings } from '../../src/server/domain/setting';
import { settingsUpdateSchema } from '../../src/server/api/settings';
import { taskExecutorTier, resolveProfileForTier } from '../../src/server/domain/model-tier';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { markExecutorFailure } from '../../src/server/domain/executor-failover';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});
afterEach(() => {
  tdb.close();
});

function seed() {
  const c = restoreWorkbench(db, { id: 'wb_fix_1', name: '公司' });
  const lead = createAgent(db, { companyId: c.id, name: '干员', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

describe('WP1 豁免蓝图自动穿戴', () => {
  it('exemptBlueprintMatch=true：同标题不穿戴人设；默认路径正常穿戴并带 blueprintTools', () => {
    const { c, p, lead } = seed();
    evolveBlueprint(db, {
      companyId: c.id, projectId: p.id, taskTitle: '优化落地页转化率',
      personaId: 'product/product-manager', personaName: '产品经理', win: true,
    });

    const plain = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '优化落地页转化率' });
    expect(plain.personaId).toBe('product/product-manager');
    expect((plain.inputProtocol as Record<string, unknown>).blueprintMatched).toBeDefined();

    const exempt = createTask(db, {
      projectId: p.id, assigneeAgentId: lead.id, title: '优化落地页转化率', exemptBlueprintMatch: true,
    });
    expect(exempt.personaId).toBeNull();
    expect((exempt.inputProtocol as Record<string, unknown>).blueprintMatched).toBeUndefined();
  });

  it('蓝图工具记账进入 inputProtocol.blueprintTools（读侧消费）', () => {
    const { c, p, lead } = seed();
    const bp = evolveBlueprint(db, {
      companyId: c.id, projectId: p.id, taskTitle: '优化落地页转化率',
      personaId: 'product/product-manager', personaName: '产品经理', win: true,
    });
    // 直接写一条工具记账（模拟反思队列回填 tools_json）
    db.prepare('UPDATE blueprint SET tools_json=? WHERE id=?').run(
      JSON.stringify([
        { kind: 'tool', id: 'web_search', uses: 5, wins: 4 },
        { kind: 'skill', id: 'source-driven-development', uses: 2, wins: 1 },
      ]),
      bp.id,
    );

    const task = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '优化落地页转化率' });
    const proto = task.inputProtocol as Record<string, unknown>;
    expect(Array.isArray(proto.blueprintTools)).toBe(true);
    expect((proto.blueprintTools as string[])[0]).toBe('web_search'); // 按使用次数排序
  });
});

describe('WP1 persona_miss 留痕（蜂群）', () => {
  it('worker 指定库外人设：根任务留 persona_miss 事件，蜂降级匿名', () => {
    const { p } = seed();
    const dispatcherAgentId = ensureDispatcherAgentId(db, p.companyId);
    const projectTask = createProjectTask(db, { projectId: p.id, title: '调研' });
    const rootTask = createTask(db, {
      projectId: p.id, projectTaskId: projectTask.id, assigneeAgentId: dispatcherAgentId, title: '组织蜂群：调研 X',
    });

    const materialized = materializeSwarm(db, rootTask, {
      goal: '调研 X',
      workers: [
        { title: '子题A', brief: '查 A', personaId: 'no-such-domain/ghost-expert' },
        { title: '子题B', brief: '查 B' },
      ],
    });
    // 指定缺失人设的蜂 → 降级匿名（无 personaId），事件留在根任务
    const beeA = getTask(db, materialized.beeTaskIds[0]!);
    expect(beeA.personaId).toBeNull();
    const miss = listTaskEvents(db, rootTask.id).find((e) => e.kind === 'persona_miss');
    expect(miss).toBeDefined();
    expect((miss!.payload as Record<string, unknown>).requestedPersonaId).toBe('no-such-domain/ghost-expert');
  });
});

describe('WP1 人设库索引', () => {
  it('listPersonaIndex：域分组 + 条目含 id/name/description，覆盖全库', () => {
    const all = listPersonas();
    const index = listPersonaIndex();
    const total = index.reduce((n, d) => n + d.items.length, 0);
    expect(total).toBe(all.length);
    expect(all.length).toBeGreaterThan(200); // 预置库 243 个
    for (const domain of index) {
      expect(domain.domain.length).toBeGreaterThan(0);
      for (const item of domain.items) {
        expect(item.id).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/i);
        expect(item.name.length).toBeGreaterThan(0);
        expect(item.description.length).toBeLessThanOrEqual(60);
      }
    }
  });
});

describe('WP9 模型档位', () => {
  const baseTask = (inputProtocol: Record<string, unknown>): Task =>
    ({
      id: 't1', seq: 1, projectTaskId: 'pt1', projectId: 'p1', parentTaskId: null, rootTaskId: null,
      dispatcherAgentId: null, assigneeAgentId: 'a1', title: 't', state: 'queued',
      acceptanceCriteria: [], artifacts: [], contextRefs: [], dependencies: [],
      inputProtocol, outputProtocol: {}, personaId: null, priority: 0, swarmId: null, swarmDepth: null,
      budget: null, reworkCount: 0, summary: null, questionOptions: [], createdAt: '', updatedAt: '',
      projectTaskSeq: null, waitingSince: null, leaseExpiresAt: null, leasedAt: null, outsourcedContractId: null,
    }) as unknown as Task;

  it('判定：蜂群工蜂/辩手/轻量咨询=低档；计划/验收/返工/裁决/请示=高档；其余标准', () => {
    expect(taskExecutorTier(baseTask({ trigger: 'swarm_bee' }))).toBe('low');
    expect(taskExecutorTier(baseTask({ trigger: 'debate_round' }))).toBe('low');
    expect(taskExecutorTier(baseTask({ lightweight: true }))).toBe('low');
    // review I3：旧分类器的 isDiscussion 列与 consultation 信号完整吸收
    expect(taskExecutorTier({ ...baseTask({}), isDiscussion: 1 })).toBe('low');
    expect(taskExecutorTier(baseTask({ consultation: true }))).toBe('low');
    expect(taskExecutorTier(baseTask({ mode: 'plan' }))).toBe('high');
    expect(taskExecutorTier(baseTask({ trigger: 'debate_verdict' }))).toBe('high');
    expect(taskExecutorTier(baseTask({ trigger: 'swarm_request' }))).toBe('high');
    expect(taskExecutorTier(baseTask({ acceptanceReview: { sourceTaskId: 'x' } }))).toBe('high');
    expect(taskExecutorTier(baseTask({ type: 'business_rework' }))).toBe('high');
    expect(taskExecutorTier(baseTask({ trigger: 'swarm_synthesis' }))).toBe('standard'); // 汇总=标准
    expect(taskExecutorTier(baseTask({}), 'debate-judge')).toBe('high');
    expect(taskExecutorTier(baseTask({ trigger: 'user_message' }))).toBe('standard');
  });

  it('档位=档案解析：新键生效；不健康/已删回落；旧键兼容读取（high←primary 等）', () => {
    const high = createExecutorProfile(db, { name: 'H', manifestId: 'custom-cli', config: { binaryPath: '/bin/ls' } });
    const std = createExecutorProfile(db, { name: 'S', manifestId: 'custom-cli', config: { binaryPath: '/bin/ls' } });
    const low = createExecutorProfile(db, { name: 'L', manifestId: 'custom-cli', config: { binaryPath: '/bin/ls' } });
    saveSystemSettings(db, { executorTierHighId: high.id, executorTierStandardId: std.id, executorTierLowId: low.id });
    expect(resolveProfileForTier(db, 'high')?.id).toBe(high.id);
    expect(resolveProfileForTier(db, 'standard')?.id).toBe(std.id);
    expect(resolveProfileForTier(db, 'low')?.id).toBe(low.id);
    // 旧键兼容：primary→high（同档键清空时回落旧键）
    saveSystemSettings(db, { executorTierHighId: '', executorTierPrimaryId: std.id });
    expect(resolveProfileForTier(db, 'high')?.id).toBe(std.id);
    // 不健康（重新指向 high 后）→ 回落 null
    saveSystemSettings(db, { executorTierHighId: high.id, executorTierPrimaryId: '' });
    markExecutorFailure(db, high.id, 'auth_error');
    expect(resolveProfileForTier(db, 'high')).toBeNull();
  });

  it('设置键往返：executorTierHigh/Standard/Low 保存读取 + zod 放行', () => {
    const parsed = settingsUpdateSchema.parse({
      claudeBin: 'claude', model: '', skipPermissions: false, timeoutMs: 600000, maxToolCalls: 30,
      executorTierHighId: 'bp_1', executorTierStandardId: 'bp_2', executorTierLowId: 'bp_3',
    });
    saveSystemSettings(db, parsed);
    const settings = getSystemSettings(db);
    expect(settings.executorTierHighId).toBe('bp_1');
    expect(settings.executorTierStandardId).toBe('bp_2');
    expect(settings.executorTierLowId).toBe('bp_3');
    // 未配置时为空（=不覆盖，零回归）
    saveSystemSettings(db, { modelTierEconomy: '', modelTierPremium: '' });
    expect(getSystemSettings(db).modelTierEconomy).toBe('');
  });
});
