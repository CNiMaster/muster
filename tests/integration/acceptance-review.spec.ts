/**
 * R2：验收员 + 任务级自动验收 集成测试。
 *
 * 验证：
 * - ensureAcceptanceOfficer：幂等、花名册可见、is_inspector 不可删、经理档权限。
 * - maybeTriggerAcceptanceReview：有标准+默认开 → 派 [验收] Task 给验收员 + 事件留痕 + 幂等；
 *   无标准 / 开关关 / 产出者=验收员 / 验收任务自身 → 不触发。
 * - handleAcceptanceReviewTaskCompleted：PASS 交付留痕；FAIL 派返工（继承标准+rework_count++）；
 *   低置信升级用户；解析失败升级用户。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany, updateCompany } from '../../src/server/domain/company';
import { createAgent, deleteAgent, listAgents } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, completeTask } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { getEmployeePermissionPolicy } from '../../src/server/domain/permission';
import {
  ensureAcceptanceOfficer,
  ACCEPTANCE_OFFICER_ROLE,
  ACCEPTANCE_OFFICER_NAME,
} from '../../src/server/domain/acceptance-officer';
import {
  maybeTriggerAcceptanceReview,
  handleAcceptanceReviewTaskCompleted,
  parseAcceptanceVerdict,
  isAutoAcceptanceEnabled,
  MAX_ACCEPTANCE_REWORK_ROUNDS,
} from '../../src/server/domain/acceptance-review';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

function seed() {
  const c = createCompany(db, { name: '公司' });
  const lead = createAgent(db, { companyId: c.id, name: '干员', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

const CRITERIA = [{ id: 'ac_1', criterion: '落地页首屏转化率达标' }];

function taskWithCriteria(projectId: string, assigneeAgentId: string, title = '优化落地页'): ReturnType<typeof getTask> {
  return createTask(db, {
    projectId, assigneeAgentId, title,
    acceptanceCriteria: CRITERIA.map((c) => ({ ...c })),
  });
}

/** 造一个"验收任务已由验收员完成"的完整态：summary 带判定契约。 */
function completeReviewTask(reviewTaskId: string, summary: string): void {
  db.prepare("UPDATE task SET state='running' WHERE id=?").run(reviewTaskId);
  completeTask(db, reviewTaskId, { outcome: 'completed', summary, outboundTasks: [], artifacts: [] });
}

describe('ensureAcceptanceOfficer 验收员实体', () => {
  it('幂等创建；花名册可见；is_inspector 不可删除；经理档', () => {
    const { c } = seed();
    const first = ensureAcceptanceOfficer(db, c.id);
    expect(ensureAcceptanceOfficer(db, c.id)).toBe(first);

    const roster = listAgents(db, c.id);
    const officer = roster.find((a) => a.id === first);
    expect(officer).toBeDefined();
    expect(officer!.role).toBe(ACCEPTANCE_OFFICER_ROLE);
    expect(officer!.name).toBe(ACCEPTANCE_OFFICER_NAME);
    // is_inspector → 不可删除
    expect(() => deleteAgent(db, first)).toThrow(/不能删除/);
    // 经理档（project scope no-approval）
    const empId = (db.prepare('SELECT id FROM company_employee WHERE legacy_agent_id=?').get(first) as { id: string }).id;
    const policy = getEmployeePermissionPolicy(db, empId);
    expect(policy!.approvalStrategy).toBe('no-approval');
    expect(policy!.scope).toBe('project');
  });

  it('Review 修复 C1：工作台 online 态也能懒确保（internalRecruit 豁免 org-lock）', () => {
    const { c, lead, p } = seed();
    // 真实运行态：任务完成时工作台 online（干员/项目先建好，再切状态）
    db.prepare("UPDATE company SET state='online' WHERE id=?").run(c.id);
    const officerId = ensureAcceptanceOfficer(db, c.id);
    expect(officerId).toMatch(/^ag_/);
    // 可见（未 hidden）
    expect(listAgents(db, c.id).some((a) => a.id === officerId)).toBe(true);
    // 触发链路在 online 态完整可用
    const task = taskWithCriteria(p.id, lead.id);
    const reviewTask = maybeTriggerAcceptanceReview(db, task);
    expect(reviewTask).not.toBeNull();
    expect(reviewTask!.assigneeAgentId).toBe(officerId);
  });
});

describe('maybeTriggerAcceptanceReview 触发', () => {
  it('有验收标准 + 默认开关 → 派 [验收] Task 给验收员 + 事件 + 幂等', () => {
    const { c, lead, p } = seed();
    const task = taskWithCriteria(p.id, lead.id);
    const reviewTask = maybeTriggerAcceptanceReview(db, task);
    expect(reviewTask).not.toBeNull();
    expect(reviewTask!.title).toContain('[验收]');
    const officerId = ensureAcceptanceOfficer(db, c.id);
    expect(reviewTask!.assigneeAgentId).toBe(officerId);
    expect((reviewTask!.inputProtocol as Record<string, unknown>).acceptanceReview).toBeTruthy();
    const events = listTaskEvents(db, task.id);
    expect(events.some((e) => e.kind === 'acceptance_dispatched')).toBe(true);
    // 幂等：再次调用不重复派
    expect(maybeTriggerAcceptanceReview(db, task)).toBeNull();
  });

  it('无验收标准 → 不触发', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '无标准任务' });
    expect(maybeTriggerAcceptanceReview(db, task)).toBeNull();
  });

  it('开关关（contractJson.autoReview=false）→ 不触发', () => {
    const { c, lead, p } = seed();
    updateCompany(db, c.id, { contractJson: { autoReview: false } });
    const task = taskWithCriteria(p.id, lead.id);
    expect(isAutoAcceptanceEnabled(db, c.id)).toBe(false);
    expect(maybeTriggerAcceptanceReview(db, task)).toBeNull();
  });

  it('产出者=验收员 → 不触发（验收员任务不被自己验收）', () => {
    const { c, p } = seed();
    const officerId = ensureAcceptanceOfficer(db, c.id);
    const task = taskWithCriteria(p.id, officerId);
    expect(maybeTriggerAcceptanceReview(db, task)).toBeNull();
  });

  it('验收任务自身 → 不触发', () => {
    const { c, lead, p } = seed();
    const source = taskWithCriteria(p.id, lead.id);
    const reviewTask = maybeTriggerAcceptanceReview(db, source)!;
    // 把验收任务再喂给触发逻辑 → 应跳过
    expect(maybeTriggerAcceptanceReview(db, reviewTask)).toBeNull();
    void c;
  });
});

describe('handleAcceptanceReviewTaskCompleted 判定落地', () => {
  it('PASS + 高置信 → 源任务 acceptance_passed 留痕', () => {
    const { lead, p } = seed();
    const source = taskWithCriteria(p.id, lead.id);
    const reviewTask = maybeTriggerAcceptanceReview(db, source)!;
    completeReviewTask(reviewTask.id, 'VERDICT=PASS\nCONFIDENCE=0.9\n全部达标');
    handleAcceptanceReviewTaskCompleted(db, getTask(db, reviewTask.id));

    const events = listTaskEvents(db, source.id);
    expect(events.some((e) => e.kind === 'acceptance_passed')).toBe(true);
    expect(events.some((e) => e.kind === 'acceptance_rework')).toBe(false);
  });

  it('FAIL + 高置信 → 派 [返工] Task（继承验收标准 + rework_count++ + 播报）', () => {
    const { lead, p } = seed();
    const source = taskWithCriteria(p.id, lead.id);
    const reviewTask = maybeTriggerAcceptanceReview(db, source)!;
    completeReviewTask(reviewTask.id, 'VERDICT=FAIL\nCONFIDENCE=0.85\n首屏转化率未达标，需重做 A/B 实验并补数据口径');
    handleAcceptanceReviewTaskCompleted(db, getTask(db, reviewTask.id));

    // 源任务计数与事件
    expect(getTask(db, source.id).reworkCount).toBe(1);
    const events = listTaskEvents(db, source.id);
    expect(events.some((e) => e.kind === 'acceptance_rework')).toBe(true);
    // 返工任务：继承验收标准
    const reworks = db.prepare(
      "SELECT id FROM task WHERE project_id=? AND title LIKE '[返工]%' ORDER BY created_at DESC LIMIT 1",
    ).all(p.id) as Array<{ id: string }>;
    expect(reworks.length).toBe(1);
    const rework = getTask(db, reworks[0]!.id);
    expect(rework.assigneeAgentId).toBe(lead.id);
    expect(rework.acceptanceCriteria).toHaveLength(1);
    expect(rework.acceptanceCriteria[0]!.criterion).toBe('落地页首屏转化率达标');
    // 播报（公司对话）
    const broadcast = db.prepare(
      "SELECT content FROM conversation_message WHERE scope_kind='company' AND content LIKE '[验收返工]%'",
    ).get() as { content: string } | undefined;
    expect(broadcast?.content).toContain('重做 A/B 实验');
  });

  it('低置信 → 升级用户（acceptance_escalated + 播报）', () => {
    const { lead, p } = seed();
    const source = taskWithCriteria(p.id, lead.id);
    const reviewTask = maybeTriggerAcceptanceReview(db, source)!;
    completeReviewTask(reviewTask.id, 'VERDICT=PASS\nCONFIDENCE=0.4\n拿不准');
    handleAcceptanceReviewTaskCompleted(db, getTask(db, reviewTask.id));

    const events = listTaskEvents(db, source.id);
    expect(events.some((e) => e.kind === 'acceptance_escalated' && (e.payload as Record<string, unknown>)?.reason === 'low-confidence')).toBe(true);
    const broadcast = db.prepare(
      "SELECT content FROM conversation_message WHERE scope_kind='company' AND content LIKE '[验收升级]%'",
    ).get() as { content: string } | undefined;
    expect(broadcast).toBeDefined();
    expect(getTask(db, source.id).reworkCount).toBe(0);
  });

  it('解析失败 → 升级用户（unparseable）', () => {
    const { lead, p } = seed();
    const source = taskWithCriteria(p.id, lead.id);
    const reviewTask = maybeTriggerAcceptanceReview(db, source)!;
    completeReviewTask(reviewTask.id, '完成，随便说说');
    handleAcceptanceReviewTaskCompleted(db, getTask(db, reviewTask.id));
    const events = listTaskEvents(db, source.id);
    expect(events.some((e) => e.kind === 'acceptance_escalated' && (e.payload as Record<string, unknown>)?.reason === 'unparseable')).toBe(true);
  });
});

describe('Review 修复 I2/I3：轮回上限与闭环排除', () => {
  it('返工任务完成会触发新一轮验收（链条闭合）；超轮回上限升级用户', () => {
    const { lead, p } = seed();
    // 第 1 轮：source FAIL → 返工 R1（reviewRound=1）
    const source = taskWithCriteria(p.id, lead.id, '首轮任务');
    let review = maybeTriggerAcceptanceReview(db, source)!;
    completeReviewTask(review.id, 'VERDICT=FAIL\nCONFIDENCE=0.9\n第一轮不通过');
    handleAcceptanceReviewTaskCompleted(db, getTask(db, review.id));
    let rework = getTask(db, (db.prepare("SELECT id FROM task WHERE input_protocol_json LIKE '%\"type\":\"business_rework\"%' ORDER BY seq DESC LIMIT 1").get() as { id: string }).id);
    expect(((rework.inputProtocol as { payload?: { reviewRound?: number } }).payload)?.reviewRound).toBe(1);

    // 第 2 轮：返工 R1 完成 → 触发新验收 → FAIL → 返工 R2（reviewRound=2）
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(rework.id);
    completeTask(db, rework.id, { outcome: 'completed', summary: '返工一次的产出', outboundTasks: [], artifacts: [] });
    const reworkDone = getTask(db, rework.id);
    review = maybeTriggerAcceptanceReview(db, reworkDone)!;
    expect(review).not.toBeNull(); // 返工结果会被再验收
    completeReviewTask(review.id, 'VERDICT=FAIL\nCONFIDENCE=0.9\n第二轮仍不通过');
    handleAcceptanceReviewTaskCompleted(db, getTask(db, review.id));
    rework = getTask(db, (db.prepare("SELECT id FROM task WHERE input_protocol_json LIKE '%\"type\":\"business_rework\"%' ORDER BY seq DESC LIMIT 1").get() as { id: string }).id);
    expect(((rework.inputProtocol as { payload?: { reviewRound?: number } }).payload)?.reviewRound).toBe(2);

    // 第 3 轮：R2 完成 → 验收 FAIL → 返工 R3（reviewRound=3，仍在上限内）
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(rework.id);
    completeTask(db, rework.id, { outcome: 'completed', summary: '返工二次', outboundTasks: [], artifacts: [] });
    review = maybeTriggerAcceptanceReview(db, getTask(db, rework.id))!;
    completeReviewTask(review.id, 'VERDICT=FAIL\nCONFIDENCE=0.9\n第三轮仍不通过');
    handleAcceptanceReviewTaskCompleted(db, getTask(db, review.id));
    rework = getTask(db, (db.prepare("SELECT id FROM task WHERE input_protocol_json LIKE '%\"type\":\"business_rework\"%' ORDER BY seq DESC LIMIT 1").get() as { id: string }).id);
    expect(((rework.inputProtocol as { payload?: { reviewRound?: number } }).payload)?.reviewRound).toBe(MAX_ACCEPTANCE_REWORK_ROUNDS);

    // 第 4 轮：R3 完成 → 验收 FAIL → 超上限 → 升级用户（不再派返工）
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(rework.id);
    completeTask(db, rework.id, { outcome: 'completed', summary: '返工三次', outboundTasks: [], artifacts: [] });
    review = maybeTriggerAcceptanceReview(db, getTask(db, rework.id))!;
    completeReviewTask(review.id, 'VERDICT=FAIL\nCONFIDENCE=0.9\n第四轮仍不通过');
    handleAcceptanceReviewTaskCompleted(db, getTask(db, review.id));
    const rounds = db.prepare("SELECT COUNT(*) AS n FROM task WHERE input_protocol_json LIKE '%\"type\":\"business_rework\"%'").get() as { n: number };
    expect(rounds.n).toBe(MAX_ACCEPTANCE_REWORK_ROUNDS); // 返工总数封顶在 3
    const escalated = db.prepare(
      "SELECT payload_json FROM task_event WHERE kind='acceptance_escalated' AND json_extract(payload_json, '$.reason')='max-rounds'",
    ).get() as { payload_json: string } | undefined;
    expect(escalated).toBeDefined();
    const broadcast = db.prepare(
      "SELECT content FROM conversation_message WHERE content LIKE '%请人工接管%'",
    ).get() as { content: string } | undefined;
    expect(broadcast).toBeDefined();
  });

  it('外包验收任务不触发验收员（避免双重返工生成器）', () => {
    const { lead, p } = seed();
    const task = createTask(db, {
      projectId: p.id, assigneeAgentId: lead.id, title: '[验收] 外包交付',
      acceptanceCriteria: CRITERIA.map((c) => ({ ...c })),
      inputProtocol: { reason: 'outsourcing_review', contractId: 'oc_test' },
    });
    expect(maybeTriggerAcceptanceReview(db, task)).toBeNull();
  });

  it('验收任务带显式 instruction（判定契约 + 标准文本）', () => {
    const { lead, p } = seed();
    const source = taskWithCriteria(p.id, lead.id);
    const reviewTask = maybeTriggerAcceptanceReview(db, source)!;
    const instruction = (reviewTask.inputProtocol as Record<string, unknown>).instruction;
    expect(typeof instruction).toBe('string');
    expect(instruction as string).toContain('VERDICT=PASS|FAIL|CHANGES');
    expect(instruction as string).toContain('落地页首屏转化率达标');
  });
});

describe('parseAcceptanceVerdict 解析', () => {
  it('标准判定契约解析（大小写不敏感 + 反馈提取）', () => {
    const parsed = parseAcceptanceVerdict('VERDICT=changes\nCONFIDENCE=0.7\n交互文案需要微调');
    expect(parsed).not.toBeNull();
    expect(parsed!.verdict).toBe('CHANGES');
    expect(parsed!.confidence).toBe(0.7);
    expect(parsed!.feedback).toContain('交互文案需要微调');
  });

  it('无法解析 → null', () => {
    expect(parseAcceptanceVerdict('完成')).toBeNull();
  });
});
