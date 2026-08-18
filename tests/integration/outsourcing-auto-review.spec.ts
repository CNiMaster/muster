/**
 * 外包自动验收（阶段四任务 4.2）集成测试。
 *
 * 验证：
 * 1. parseReviewVerdict：解析 VERDICT=xxx + feedback
 * 2. delivered 契约触发 [验收] Task（给甲方第一负责人）+ 契约进 reviewing
 * 3. 验收通过（VERDICT=completed）→ 契约 completed + 甲方源任务被唤醒
 * 4. 验收要求返工（changes_requested）→ 契约回流 in_progress + 创建返工任务
 * 5. 返工轮次超阈值 → 转人工（不派验收 Task）
 * 6. 关闭自动验收（autoReviewOutsourcing=false）→ 不派验收 Task
 * 7. 解析失败 → 转人工
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
import { createCompany, transitionCompany, updateCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import {
  createOutsourcingContract,
  getOutsourcingContract,
  acceptContract,
  createOutsourcedTask,
  createReworkTask,
  submitReview,
  markDelivered,
} from '../../src/server/domain/outsourcing-contract';
import { createTask, addDependency } from '../../src/server/domain/task';
import { triggerAutoReview, handleOutsourcingReviewTaskCompleted, parseReviewVerdict } from '../../src/server/domain/outsourcing-review';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

/** 造一个 delivered 契约的完整链路（甲方在线、乙方在线、乙方接受、乙方创建承接任务并完工）。 */
function deliveredContract() {
  const a = createCompany(db, { name: '甲方' });
  const b = createCompany(db, { name: '乙方' });
  const aLead = createAgent(db, { companyId: a.id, name: 'a-lead', role: 'lead' });
  const bLead = createAgent(db, { companyId: b.id, name: 'b-lead', role: 'lead' });
  transitionCompany(db, a.id, 'online');
  transitionCompany(db, b.id, 'online');
  const project = createProject(db, { companyId: a.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: aLead.id, initialState: 'active' });
  // 甲方源任务（模拟等待外包交付）
  const sourceTask = createTask(db, { projectId: project.id, assigneeAgentId: aLead.id, title: '源任务：等封面' });
  const contract = createOutsourcingContract(db, {
    sourceCompanyId: a.id,
    targetCompanyId: b.id,
    sourceProjectId: project.id,
    sourceTaskId: sourceTask.id,
    title: '设计封面',
    brief: '为小说设计封面',
  });
  acceptContract(db, contract.id, bLead.id);
  // 乙方承接任务（在乙方项目内）
  const outsourced = createOutsourcedTask(db, contract.id);
  markDelivered(db, contract.id);
  // 契约对象是创建时快照；DB 状态已流转，测试侧用最新读取
  const latest = getOutsourcingContract(db, contract.id);
  return { a, b, aLead, bLead, project, sourceTask, contract: latest, outsourced };
}

describe('parseReviewVerdict', () => {
  it('解析 VERDICT + feedback', () => {
    expect(parseReviewVerdict('VERDICT=completed\n封面符合要求')).toEqual({ verdict: 'completed', feedback: '封面符合要求' });
    expect(parseReviewVerdict('VERDICT=changes_requested：请修改字体')).toEqual({ verdict: 'changes_requested', feedback: '请修改字体' });
    expect(parseReviewVerdict('VERDICT=rejected')).toEqual({ verdict: 'rejected', feedback: '' });
    expect(parseReviewVerdict('随便写点什么')).toBeNull();
  });
});

describe('triggerAutoReview（delivered → [验收] Task）', () => {
    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('delivered 契约给甲方第一负责人派 [验收] Task，契约进 reviewing', () => {
    const { aLead, contract } = deliveredContract();
    const reviewTask = triggerAutoReview(db, contract);
    expect(reviewTask).not.toBeNull();
    expect(reviewTask!.assigneeAgentId).toBe(aLead.id);
    expect(reviewTask!.title).toContain('[验收]');
    expect((reviewTask!.inputProtocol as { reason: string }).reason).toBe('outsourcing_review');
    expect(getOutsourcingContract(db, contract.id).state).toBe('reviewing');
  });

    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('重复触发不重复派验收 Task', () => {
    const { contract } = deliveredContract();
    const first = triggerAutoReview(db, contract);
    const second = triggerAutoReview(db, contract);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('甲方关闭自动验收时不派验收 Task', () => {
    const { a, contract } = deliveredContract();
    updateCompany(db, a.id, { contractJson: { autoReviewOutsourcing: false } });
    expect(triggerAutoReview(db, contract)).toBeNull();
  });

    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('返工轮次超阈值时转人工（不派验收 Task）', () => {
    const { contract } = deliveredContract();
    db.prepare('UPDATE outsourcing_contract SET revision_round=? WHERE id=?').run(3, contract.id);
    const latest = getOutsourcingContract(db, contract.id);
    expect(triggerAutoReview(db, latest)).toBeNull();
  });
});

describe('handleOutsourcingReviewTaskCompleted（验收结论落地）', () => {
    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('VERDICT=completed → 契约完成 + 甲方源任务唤醒', () => {
    const { aLead, contract, sourceTask, outsourced } = deliveredContract();
    const reviewTask = triggerAutoReview(db, contract)!;
    // 乙方承接任务已完工（completed）；甲方源任务依赖乙方承接任务（任务 4.3 语义）
    db.prepare("UPDATE task SET state='completed', outcome='completed', updated_at=? WHERE id=?").run(new Date().toISOString(), outsourced.task.id);
    db.prepare("UPDATE task SET state='waiting_dependency', updated_at=? WHERE id=?").run(new Date().toISOString(), sourceTask.id);
    addDependency(db, sourceTask.id, outsourced.task.id);
    db.prepare("UPDATE task SET state='running', updated_at=? WHERE id=?").run(new Date().toISOString(), reviewTask.id);
    db.prepare("UPDATE task SET summary=? WHERE id=?").run('VERDICT=completed\n封面质量达标', reviewTask.id);

    handleOutsourcingReviewTaskCompleted(db, { ...reviewTask, summary: 'VERDICT=completed\n封面质量达标' });

    expect(getOutsourcingContract(db, contract.id).state).toBe('completed');
    const source = db.prepare('SELECT state FROM task WHERE id=?').get(sourceTask.id) as { state: string };
    expect(source.state).toBe('queued');
    void aLead;
  });

    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('VERDICT=changes_requested → 契约回流 in_progress + 创建返工任务', () => {
    const { contract } = deliveredContract();
    const reviewTask = triggerAutoReview(db, contract)!;
    handleOutsourcingReviewTaskCompleted(db, { ...reviewTask, summary: 'VERDICT=changes_requested\n字体需要修改' });

    const after = getOutsourcingContract(db, contract.id);
    expect(after.state).toBe('in_progress');
    expect(after.revisionRound).toBe(1);
    const rework = db.prepare(`SELECT id FROM task WHERE title LIKE '[返工]%'`).get() as { id: string } | undefined;
    expect(rework).toBeDefined();
  });

    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('VERDICT=rejected → 契约拒绝', () => {
    const { contract } = deliveredContract();
    const reviewTask = triggerAutoReview(db, contract)!;
    handleOutsourcingReviewTaskCompleted(db, { ...reviewTask, summary: 'VERDICT=rejected\n不符合需求' });
    expect(getOutsourcingContract(db, contract.id).state).toBe('rejected');
  });

    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('解析失败 → 契约保持 reviewing，通知转人工', () => {
    const { contract } = deliveredContract();
    const reviewTask = triggerAutoReview(db, contract)!;
    handleOutsourcingReviewTaskCompleted(db, { ...reviewTask, summary: '我不确定怎么评价' });
    // 契约不流转（仍在 reviewing），等待人工
    expect(getOutsourcingContract(db, contract.id).state).toBe('reviewing');
    // 项目对话窗口有转人工提示
    const msgs = db.prepare("SELECT content FROM conversation_message WHERE scope_id=? ORDER BY created_at DESC").all(contract.sourceProjectId) as Array<{ content: string }>;
    expect(msgs.some((m) => m.content.includes('转人工验收'))).toBe(true);
  });

    // D-Task4 归并 B2B 死流后移除 skip
  it.skip('M-3：手动验收超返工上限被 submitReview 拒绝（手动路径兜底）', () => {
    const { contract } = deliveredContract();
    // 默认 maxRounds=3：连做 3 轮返工（revisionRound 0→3）
    for (let i = 0; i < 3; i++) {
      submitReview(db, contract.id, 'changes_requested', `反馈 ${i}`);
      createReworkTask(db, contract.id, `反馈 ${i}`);
      markDelivered(db, contract.id);
    }
    expect(getOutsourcingContract(db, contract.id).revisionRound).toBe(3);
    // 第 4 次 changes_requested 被拒绝（此前手动 API 路径可无限返工）
    expect(() => submitReview(db, contract.id, 'changes_requested', '再来一轮')).toThrow(/返工上限/);
    // 契约仍可正常结束（completed 不受返工上限限制）
    submitReview(db, contract.id, 'completed');
    expect(getOutsourcingContract(db, contract.id).state).toBe('completed');
  });
});
