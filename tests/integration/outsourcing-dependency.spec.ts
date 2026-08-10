/**
 * 外包与 task_dependency 打通（阶段四任务 4.3）集成测试。
 *
 * 验证：
 * 1. createOutsourcedTask 后：running 源任务 → waiting_dependency + 跨公司依赖建立
 * 2. queued 源任务：仅建依赖（状态不变，依赖满足后自然放行）
 * 3. 乙方承接任务完成后 resumeDependents 唤醒甲方源任务
 * 4. 乙方承接任务失败 → 甲方源任务收到失败通知（阶段一失败传播跨公司）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
import { createCompany, transitionCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import {
  createOutsourcingContract,
  getOutsourcingContract,
  acceptContract,
  createOutsourcedTask,
  markDelivered,
} from '../../src/server/domain/outsourcing-contract';
import { createTask, getTask, failTask, areDependenciesMet, resumeDependents } from '../../src/server/domain/task';
import { listTaskMessages } from '../../src/server/domain/task-message';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

function fixture(sourceTaskState: 'queued' | 'running') {
  const a = createCompany(db, { name: '甲方' });
  const b = createCompany(db, { name: '乙方' });
  const aLead = createAgent(db, { companyId: a.id, name: 'a-lead', role: 'lead' });
  const bLead = createAgent(db, { companyId: b.id, name: 'b-lead', role: 'lead' });
  transitionCompany(db, a.id, 'online');
  transitionCompany(db, b.id, 'online');
  const project = createProject(db, { companyId: a.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: aLead.id, initialState: 'active' });
  const sourceTask = createTask(db, { projectId: project.id, assigneeAgentId: aLead.id, title: '源任务' });
  if (sourceTaskState === 'running') {
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), sourceTask.id);
  }
  const contract = createOutsourcingContract(db, {
    sourceCompanyId: a.id,
    targetCompanyId: b.id,
    sourceProjectId: project.id,
    sourceTaskId: sourceTask.id,
    title: '外包任务',
    brief: 'b',
  });
  acceptContract(db, contract.id, bLead.id);
  return { a, b, aLead, bLead, project, sourceTask, contract };
}

describe('外包与 task_dependency 打通（阶段四任务 4.3）', () => {
  it('running 源任务在创建承接任务后进入 waiting_dependency 并建立依赖', () => {
    const { sourceTask, contract } = fixture('running');
    const outsourced = createOutsourcedTask(db, contract.id);

    expect(getTask(db, sourceTask.id).state).toBe('waiting_dependency');
    expect(areDependenciesMet(db, sourceTask.id)).toBe(false);
    const dep = db.prepare('SELECT 1 FROM task_dependency WHERE task_id=? AND depends_on_id=?').get(sourceTask.id, outsourced.task.id);
    expect(dep).toBeDefined();
  });

  it('queued 源任务仅建依赖，状态不变，依赖满足后自然放行', () => {
    const { sourceTask, contract } = fixture('queued');
    const outsourced = createOutsourcedTask(db, contract.id);

    expect(getTask(db, sourceTask.id).state).toBe('queued');
    const dep = db.prepare('SELECT 1 FROM task_dependency WHERE task_id=? AND depends_on_id=?').get(sourceTask.id, outsourced.task.id);
    expect(dep).toBeDefined();
    // 乙方完工 → 依赖满足（outsourced task completed）
    db.prepare("UPDATE task SET state='completed', outcome='completed', updated_at=? WHERE id=?").run(new Date().toISOString(), outsourced.task.id);
    expect(areDependenciesMet(db, sourceTask.id)).toBe(true);
  });

  it('claimed 源任务在创建承接任务后同样进入 waiting_dependency 并建立依赖', () => {
    // 行为覆盖（claimed 路径）：claimed 源任务应被置为 waiting_dependency + 建依赖。
    // 注意：本测试不区分 H-2 修复前后——原优先级 bug `(source && running) || (source?.claimed)`
    // 在 claimed 场景下右半短路成立，行为恰好正确。H-2 是 latent 修复（防未来重构引爆），
    // 其正确性由 typecheck + 代码审查保证，无法用行为测试覆盖。
    const { sourceTask, contract } = fixture('queued');
    // 源任务处于 claimed 状态（引擎已领取但未 running）
    db.prepare("UPDATE task SET state='claimed', lease_owner_thread_id='th_x', updated_at=? WHERE id=?").run(new Date().toISOString(), sourceTask.id);
    const outsourced = createOutsourcedTask(db, contract.id);

    expect(getTask(db, sourceTask.id).state).toBe('waiting_dependency');
    const dep = db.prepare('SELECT 1 FROM task_dependency WHERE task_id=? AND depends_on_id=?').get(sourceTask.id, outsourced.task.id);
    expect(dep).toBeDefined();
  });

  it('乙方承接任务完成后 resumeDependents 唤醒甲方源任务', () => {
    const { sourceTask, contract } = fixture('running');
    const outsourced = createOutsourcedTask(db, contract.id);
    // 乙方完工（completed）+ delivered
    db.prepare("UPDATE task SET state='completed', outcome='completed', updated_at=? WHERE id=?").run(new Date().toISOString(), outsourced.task.id);
    markDelivered(db, contract.id);
    // 验收通过（模拟 4.2 的 handleOutsourcingReviewTaskCompleted 中 resumeDependents）
    resumeDependents(db, outsourced.task.id);
    expect(getTask(db, sourceTask.id).state).toBe('queued');
  });

  it('乙方承接任务失败 → 甲方源任务收到失败通知（跨公司失败传播）', () => {
    const { sourceTask, contract } = fixture('running');
    const outsourced = createOutsourcedTask(db, contract.id);
    // 乙方任务失败（可重试错误会被自动重试，这里用不可重试错误直接 failed）
    failTask(db, outsourced.task.id, '执行异常：permission denied');

    // 源任务收到 [子任务失败] 通知
    const msgs = listTaskMessages(db, sourceTask.id);
    expect(msgs.some((m) => m.content.includes('子任务失败'))).toBe(true);
  });

  it('契约无 sourceTaskId（用户手动发起）时不建立依赖', () => {
    const a = createCompany(db, { name: '甲方2' });
    const b = createCompany(db, { name: '乙方2' });
    const aLead = createAgent(db, { companyId: a.id, name: 'a-lead', role: 'lead' });
    const bLead = createAgent(db, { companyId: b.id, name: 'b-lead', role: 'lead' });
    transitionCompany(db, a.id, 'online');
    transitionCompany(db, b.id, 'online');
    const project = createProject(db, { companyId: a.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: aLead.id, initialState: 'active' });
    const contract = createOutsourcingContract(db, {
      sourceCompanyId: a.id,
      targetCompanyId: b.id,
      sourceProjectId: project.id,
      title: '手动外包',
      brief: 'b',
    });
    acceptContract(db, contract.id, bLead.id);
    const outsourced = createOutsourcedTask(db, contract.id);
    const deps = db.prepare('SELECT COUNT(*) as n FROM task_dependency WHERE depends_on_id=?').get(outsourced.task.id) as { n: number };
    expect(deps.n).toBe(0);
    expect(getOutsourcingContract(db, contract.id).state).toBe('in_progress');
  });
});
