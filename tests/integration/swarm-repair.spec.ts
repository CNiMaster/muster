import { clockIn, restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 蜂群失败自动修复（执行过程展示批次4）：
 * - 不可恢复失败的蜂 → 自动生成替补蜂（换思路：注入失败摘要 + 教训）
 * - 原蜂标记 superseded_by；根任务留 notice trace 与 swarm_bee_repair_dispatched 事件
 * - 每蜂只修一次（替补蜂再失败不递归）；全群修复上限 swarm_repair_max
 * - 群已熔断（status=failed）不再修复
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createSwarmRun } from '../../src/server/domain/swarm';
import { createTask, failTask, getTask, addDependency } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { listTrace } from '../../src/server/domain/execution-trace';
import { setSetting } from '../../src/server/domain/setting';
import { ensureSystemAgents } from '../../src/server/domain/system-agents';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

function makeSwarmFixture(): { rootId: string; beeId: string; synthesisId: string } {
  // 真实语义：蜂群由系统隐形岗「调度中心」派发（is_system 豁免 contactAllow 守卫）
  const company = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' });
  const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
  const project = createProject(db, { companyId: company.id, name: 'novel', rootDir: '/tmp/swarm-repair', firstAgentId: lead.id, initialState: 'active' });
  clockIn(db);
  const sys = ensureSystemAgents(db, company.id);
  const dispatcher = sys.dispatcherAgentId;
  const root = createTask(db, {
    projectId: project.id,
    assigneeAgentId: dispatcher,
    dispatcherAgentId: dispatcher,
    title: '放蜂任务',
    priority: 5,
    skipLaunchGate: true,
  });
  const swarm = createSwarmRun(db, { companyId: company.id, projectId: project.id, rootTaskId: root.id, goal: '宣发物料' });
  db.prepare('UPDATE task SET swarm_id=?, swarm_depth=0 WHERE id=?').run(swarm.id, root.id);
  const bee = createTask(db, {
    projectId: project.id,
    parentTaskId: root.id,
    rootTaskId: root.id,
    assigneeAgentId: lead.id,
    dispatcherAgentId: dispatcher,
    title: '画海报',
    priority: 5,
    skipLaunchGate: true,
    swarmId: swarm.id,
    swarmDepth: 1,
    inputProtocol: { trigger: 'swarm_bee', swarm: { swarmId: swarm.id, goal: '宣发物料', brief: '画一张海报', depth: 1 }, swarmNode: true },
  });
  // 生产语义：nodes_total = 蜂 + 汇总任务（materializeSwarm 的账），单蜂失败不会误触关群
  db.prepare('UPDATE swarm_run SET nodes_total=2 WHERE id=?').run(swarm.id);
  // 汇总任务：依赖全部蜂，根依赖汇总（与 materializeSwarm 同构）
  const synthesis = createTask(db, {
    projectId: project.id,
    parentTaskId: root.id,
    rootTaskId: root.id,
    assigneeAgentId: dispatcher,
    dispatcherAgentId: dispatcher,
    title: '[蜂群汇总] 宣发物料',
    priority: 6,
    skipLaunchGate: true,
    swarmId: swarm.id,
    swarmDepth: 0,
    inputProtocol: { trigger: 'swarm_synthesis', swarm: { swarmId: swarm.id, goal: '宣发物料', beeCount: 1 }, swarmSynthesis: true, swarmNode: true },
  });
  addDependency(db, synthesis.id, bee.id);
  addDependency(db, root.id, synthesis.id);
  db.prepare('UPDATE swarm_run SET synthesis_task_id=? WHERE id=?').run(synthesis.id, swarm.id);
  // 引擎语义：汇总任务因依赖未满足处于等待态（review I2 的放行场景载体）
  db.prepare("UPDATE task SET state='waiting_dependency' WHERE id=?").run(synthesis.id);
  return { rootId: root.id, beeId: bee.id, synthesisId: synthesis.id };
}

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('蜂群失败自动修复', () => {
  it('不可恢复失败的蜂自动生成替补并标记 superseded_by', () => {
    const { rootId, beeId } = makeSwarmFixture();
    const failed = failTask(db, beeId, '逻辑错误：海报主题跑偏，与宣传文案矛盾');
    expect(failed.state).toBe('failed');
    const fixed = getTask(db, beeId);
    expect(fixed.supersededBy).not.toBeNull();
    const replacement = getTask(db, fixed.supersededBy!);
    expect(replacement.swarmId).toBe(fixed.swarmId);
    expect(replacement.title).toContain('[替补]');
    const proto = replacement.inputProtocol as Record<string, unknown>;
    expect(proto.repair).toMatchObject({ ofTaskId: beeId, failure: expect.stringContaining('逻辑错误') });
    // 根任务留痕：trace notice + 事件
    expect(listTrace(db, rootId).some((x) => x.kind === 'notice')).toBe(true);
    expect(listTaskEvents(db, rootId).some((e) => e.kind === 'swarm_bee_repair_dispatched')).toBe(true);
    // 计账：nodes_total 2（蜂+汇总）→ 修复 +1 = 3
    const swarm = db.prepare('SELECT nodes_total FROM swarm_run WHERE root_task_id=?').get(rootId) as { nodes_total: number };
    expect(swarm.nodes_total).toBe(3);
  });

  it('review I2 回归：替补接入汇总依赖——蜂失败后汇总仍等替补收口', () => {
    const { rootId, beeId, synthesisId } = makeSwarmFixture();
    failTask(db, beeId, '逻辑错误：需要替补');
    const replacementId = getTask(db, beeId).supersededBy!;
    expect(replacementId).not.toBeNull();
    // 依赖行存在：汇总 → 替补
    const dep = db.prepare('SELECT 1 AS x FROM task_dependency WHERE task_id=? AND depends_on_id=?').get(synthesisId, replacementId);
    expect(dep).toBeTruthy();
    // 汇总任务未被放行（仍等替补收口），根任务也未收口
    expect(getTask(db, synthesisId).state).toBe('waiting_dependency');
    expect(getTask(db, rootId).state).toBe('queued');
  });

  it('替补蜂再失败不再递归修复', () => {
    const { beeId } = makeSwarmFixture();
    failTask(db, beeId, '逻辑错误：第一次失败');
    const replacementId = getTask(db, beeId).supersededBy!;
    failTask(db, replacementId, '逻辑错误：替补也失败');
    expect(getTask(db, replacementId).supersededBy).toBeNull();
  });

  it('全群修复数超 swarm_repair_max 后不再修复', () => {
    setSetting(db, 'swarm_repair_max', '1');
    const { rootId, beeId } = makeSwarmFixture();
    const root = getTask(db, rootId);
    const swarmId = root.swarmId!;
    const second = createTask(db, {
      projectId: root.projectId, parentTaskId: root.id, rootTaskId: root.id,
      assigneeAgentId: root.assigneeAgentId, dispatcherAgentId: root.dispatcherAgentId,
      title: '写文案', priority: 5, skipLaunchGate: true, swarmId, swarmDepth: 1,
      inputProtocol: { trigger: 'swarm_bee', swarm: { swarmId, goal: 'g', brief: '写文案', depth: 1 }, swarmNode: true },
    });
    failTask(db, beeId, '逻辑错误：甲失败');
    failTask(db, second.id, '逻辑错误：乙失败');
    expect(getTask(db, beeId).supersededBy).not.toBeNull();
    expect(getTask(db, second.id).supersededBy).toBeNull();
  });

  it('群已熔断（failed）不再修复', () => {
    const { rootId, beeId } = makeSwarmFixture();
    db.prepare('UPDATE swarm_run SET status=? WHERE root_task_id=?').run('failed', rootId);
    failTask(db, beeId, '逻辑错误：失败');
    expect(getTask(db, beeId).supersededBy).toBeNull();
  });
});
