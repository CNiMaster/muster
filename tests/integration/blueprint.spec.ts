import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 蓝图组织重构 批次3：蓝图环集成测试。
 *
 * 验证：
 * - taskTypeOf 确定性归类（词序无关）。
 * - evolveBlueprint 记账/聚类（同类型合并进同一蓝图、人设并入、来源项目记账）。
 * - matchBlueprint 相似匹配 + retired 不参与 + 战绩排序。
 * - createTask 钩子：自动穿戴（审计 meta 入 inputProtocol）；显式指定不被覆盖；无命中不穿戴。
 * - 反思 drain → 蓝图进化端到端（胜/负记账）。
 * - 动态通信图：同项目有线程的成员互可派发（无需 contactAllow）；无线程仍拒绝。
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import * as llmCallModule from '../../src/server/domain/llm-call';
;
import { createAgent, updateAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, failTask, completeTask } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { enqueueReflection, drainReflectionQueue } from '../../src/server/domain/reflection';
import {
  taskTypeOf,
  jaccard,
  matchBlueprint,
  evolveBlueprint,
  listBlueprints,
  setBlueprintStatus,
} from '../../src/server/domain/blueprint';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});
afterEach(() => {
  tdb.close();
  vi.restoreAllMocks();
});

const PERSONA_ID = 'product/product-manager';

function seed() {
  const c = restoreWorkbench(db, { id: 'wb_fix_1', name: '公司' });
  const lead = createAgent(db, { companyId: c.id, name: '领班', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

const mockLlmResult = (content: string) => ({ content, model: 'mock', usage: { promptTokens: 1, completionTokens: 1 } });

describe('任务类型归类', () => {
  it('类型键确定性：同一标题同一键，不同标题不同键', () => {
    expect(taskTypeOf('优化落地页转化率')).toBe(taskTypeOf('优化落地页转化率'));
    expect(taskTypeOf('优化落地页转化率')).not.toBe(taskTypeOf('写技术方案文档'));
  });

  it('jaccard 度量：部分重叠给中间分值', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
    expect(jaccard(['a', 'b', 'c'], ['a', 'b', 'd'])).toBeCloseTo(2 / 4);
  });
});

describe('evolveBlueprint 进化记账', () => {
  it('首次进化新建蓝图；同类活（词序变化）按相似度合并进同一蓝图', () => {
    const { c, p } = seed();
    const first = evolveBlueprint(db, {
      companyId: c.id, projectId: p.id, taskTitle: '优化落地页转化率',
      personaId: PERSONA_ID, personaName: '产品经理', win: true,
    });
    expect(first.wins).toBe(1);
    expect(first.losses).toBe(0);
    expect(first.staffing).toHaveLength(1);

    const second = evolveBlueprint(db, {
      companyId: c.id, projectId: p.id, taskTitle: '转化率落地页优化', // 同类活（Jaccard >= 0.4 合并）
      personaId: 'marketing/marketing-content-creator', personaName: '内容创作者', win: false,
    });
    expect(second.id).toBe(first.id); // 合并进同一张蓝图
    expect(second.wins).toBe(1);
    expect(second.losses).toBe(1);
    expect(second.staffing).toHaveLength(2); // 人设并入
    expect(listBlueprints(db, c.id)).toHaveLength(1);
  });

  it('不同类型的活不合并（低于合并阈值各自成图）', () => {
    const { c, p } = seed();
    evolveBlueprint(db, {
      companyId: c.id, projectId: p.id, taskTitle: '优化落地页转化率',
      personaId: PERSONA_ID, personaName: '产品经理', win: true,
    });
    evolveBlueprint(db, {
      companyId: c.id, projectId: p.id, taskTitle: '配置数据库备份策略',
      personaId: PERSONA_ID, personaName: '产品经理', win: true,
    });
    expect(listBlueprints(db, c.id)).toHaveLength(2);
  });
});

describe('matchBlueprint 匹配', () => {
  it('相似任务命中高战绩蓝图；retired 不参与', () => {
    const { c, p } = seed();
    evolveBlueprint(db, {
      companyId: c.id, projectId: p.id, taskTitle: '优化落地页转化率',
      personaId: PERSONA_ID, personaName: '产品经理', win: true,
    });
    const match = matchBlueprint(db, c.id, '提升落地页转化效果');
    expect(match).not.toBeNull();
    expect(match!.blueprint.staffing[0]!.personaId).toBe(PERSONA_ID);

    setBlueprintStatus(db, match!.blueprint.id, 'retired');
    expect(matchBlueprint(db, c.id, '提升落地页转化效果')).toBeNull();
  });

  it('不相似任务不命中（Jaccard 低于阈值）', () => {
    const { c, p } = seed();
    evolveBlueprint(db, {
      companyId: c.id, projectId: p.id, taskTitle: '优化落地页转化率',
      personaId: PERSONA_ID, personaName: '产品经理', win: true,
    });
    expect(matchBlueprint(db, c.id, '配置数据库备份策略')).toBeNull();
  });

  it('Review 修复：退役蓝图的同类新证据会复活（合并而非 UNIQUE 冲突丢战绩）', () => {
    const { c, p } = seed();
    const first = evolveBlueprint(db, {
      companyId: c.id, projectId: p.id, taskTitle: '优化落地页转化率',
      personaId: PERSONA_ID, personaName: '产品经理', win: true,
    });
    setBlueprintStatus(db, first.id, 'retired');
    // 退役后新来的同类活：合并进同一张蓝图并复活
    const revived = evolveBlueprint(db, {
      companyId: c.id, projectId: p.id, taskTitle: '优化落地页转化率二期',
      personaId: PERSONA_ID, personaName: '产品经理', win: true,
    });
    expect(revived.id).toBe(first.id);
    expect(revived.status).toBe('active');
    expect(revived.wins).toBe(2);
    expect(listBlueprints(db, c.id)).toHaveLength(1);
  });
});

describe('createTask 蓝图匹配钩子', () => {
  it('无显式指定的任务自动穿戴蓝图首槽人设，匹配结果入 inputProtocol 审计', () => {
    const { c, lead, p } = seed();
    evolveBlueprint(db, {
      companyId: c.id, projectId: p.id, taskTitle: '优化落地页转化率',
      personaId: PERSONA_ID, personaName: '产品经理', win: true,
    });
    const task = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '优化落地页转化率' });
    expect(task.personaId).toBe(PERSONA_ID);
    expect(task.inputProtocol.blueprintMatched).toBeTruthy();
  });

  it('显式 personaId 不被蓝图覆盖', () => {
    const { c, lead, p } = seed();
    evolveBlueprint(db, {
      companyId: c.id, projectId: p.id, taskTitle: '优化落地页转化率',
      personaId: PERSONA_ID, personaName: '产品经理', win: true,
    });
    const task = createTask(db, {
      projectId: p.id, assigneeAgentId: lead.id, title: '优化落地页转化率', personaId: 'engineering/backend-architect',
    });
    expect(task.personaId).toBe('engineering/backend-architect');
    expect(task.inputProtocol.blueprintMatched).toBeUndefined();
  });

  it('无蓝图时任务不穿戴（现状行为）', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '全新类型的活' });
    expect(task.personaId).toBeNull();
  });
});

describe('反思 drain → 蓝图进化端到端', () => {
  it('穿戴人设的任务终态后，drain 自动记账蓝图胜负', async () => {
    const { lead, p } = seed();
    const win = createTask(db, { projectId: p.id, title: '优化落地页转化率', assigneeAgentId: lead.id, personaId: PERSONA_ID });
    const loss = createTask(db, { projectId: p.id, title: '优化落地页转化率二期', assigneeAgentId: lead.id, personaId: PERSONA_ID });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(win.id);
    const completed = completeTask(db, win.id, { outcome: 'completed', summary: '完成', outboundTasks: [], artifacts: [] });
    enqueueReflection(db, { task: completed, outcome: 'completed', signal: 'completed' });
    const failed = failTask(db, loss.id, '错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult('SKIPPED'));
    await drainReflectionQueue(db, { maxPerTick: 5 });

    const blueprints = listBlueprints(db, p.companyId);
    expect(blueprints).toHaveLength(1);
    expect(blueprints[0]!.wins).toBe(1);
    expect(blueprints[0]!.losses).toBe(1);
  });

  it('无人设任务不产生蓝图（蓝图是人设组合的战绩）', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '普通任务', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, '错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult('SKIPPED'));
    await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(listBlueprints(db, p.companyId)).toHaveLength(0);
  });
});

describe('动态通信图（同项目成员互可派发）', () => {
  it('assignee 在项目有线程 → contactAllow 外也可派发', () => {
    const { c, lead, p } = seed();
    const member = createAgent(db, { companyId: c.id, name: '成员', role: 'engineer' });
    // lead 的 contactAllow 不含 member；member 加入项目（有线程）
    ensurePrimaryThread(db, p.id, member.id);
    const task = createTask(db, {
      projectId: p.id, dispatcherAgentId: lead.id, assigneeAgentId: member.id, title: '协作任务',
    });
    expect(task.assigneeAgentId).toBe(member.id);
  });

  it('assignee 无项目线程且不在 contactAllow → 仍拒绝', () => {
    const { c, lead, p } = seed();
    const outsider = createAgent(db, { companyId: c.id, name: '外人', role: 'engineer' });
    expect(() => createTask(db, {
      projectId: p.id, dispatcherAgentId: lead.id, assigneeAgentId: outsider.id, title: '越界任务',
    })).toThrow(/未授权联系/);
  });

  it('contactAllow 白名单路径保持不变（无线程但显式授权可派发）', () => {
    const { c, lead, p } = seed();
    const friend = createAgent(db, { companyId: c.id, name: '伙伴', role: 'engineer' });
    updateAgent(db, lead.id, { contactAllow: [friend.id] });
    const task = createTask(db, {
      projectId: p.id, dispatcherAgentId: lead.id, assigneeAgentId: friend.id, title: '白名单任务',
    });
    expect(task.assigneeAgentId).toBe(friend.id);
  });
});
