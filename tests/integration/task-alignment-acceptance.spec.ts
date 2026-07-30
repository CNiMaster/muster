/**
 * 双 Loop 地基 + 任务驱动闭环（P0/P1/P2）集成测试。
 *
 * 覆盖：
 * - P0.1：acceptanceCriteria 升为一等数据（createTask 落库、getTask 读回）。
 * - P0.2：interruption_count 在各类阻塞入口自增（追问/审批/pause/block/business-review blocking）。
 * - P0.3：assembleContext 注入 # 验收标准。
 * - P1：开始段对齐（requestAlignment/answerAlignment、alignment_rounds 计数、超限上报）。
 * - P2：completeTask 写回 acceptanceMet；business-review 返工继承 acceptance。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { getAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import {
  createTask,
  getTask,
  completeTask,
  requestAlignment,
  answerAlignment,
  markTaskWaitingApproval,
  blockTask,
  pauseTask,
} from '../../src/server/domain/task';
import {
  submitBusinessReview,
  decideBusinessReview,
} from '../../src/server/domain/business-review';
import { assembleContext } from '../../src/server/executors/context';
import { MAX_ALIGNMENT_ROUNDS } from '../../src/shared/constants';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

/** 标准三件套：公司 + lead 员工 + 项目。 */
function seed() {
  const c = createCompany(db, { name: '测试公司' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id });
  return { c, lead, p };
}

describe('P0.1 验收标准一等数据', () => {
  it('createTask 带 acceptanceCriteria 落库并可读回', () => {
    const { lead, p } = seed();
    const task = createTask(db, {
      projectId: p.id,
      title: '写章节',
      assigneeAgentId: lead.id,
      acceptanceCriteria: [
        { id: 'ac_1', criterion: '不少于 3000 字' },
        { id: 'ac_2', criterion: '包含主角对话' },
      ],
    });
    const got = getTask(db, task.id);
    expect(got.acceptanceCriteria).toHaveLength(2);
    expect(got.acceptanceCriteria[0]!.criterion).toBe('不少于 3000 字');
    expect(got.acceptanceCriteria[1]!.id).toBe('ac_2');
  });

  it('未传 acceptanceCriteria 时默认空数组', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    expect(getTask(db, task.id).acceptanceCriteria).toEqual([]);
  });
});

describe('P0.2 打断计数 interruption_count', () => {
  it('追问（waiting_input）+1', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    completeTask(db, task.id, { outcome: 'waiting_input', summary: '需澄清', outboundTasks: [], artifacts: [], question: '几章？' });
    expect(getTask(db, task.id).interruptionCount).toBe(1);
  });

  it('审批门 markTaskWaitingApproval +1', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    markTaskWaitingApproval(db, task.id, 'approval_1');
    expect(getTask(db, task.id).interruptionCount).toBe(1);
  });

  it('pauseTask +1', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    pauseTask(db, task.id);
    expect(getTask(db, task.id).interruptionCount).toBe(1);
  });

  it('blockTask +1', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    blockTask(db, task.id, '冲突');
    expect(getTask(db, task.id).interruptionCount).toBe(1);
  });

  it('business-review blocking 模式 +1', () => {
    const { c, lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    submitBusinessReview(db, {
      companyId: c.id, projectId: p.id, taskId: task.id, employeeId: lead.id,
      reviewKind: 'artifact', subjectId: 's1', subjectSnapshot: {}, title: '成品',
    });
    expect(getTask(db, task.id).interruptionCount).toBe(1);
  });

  it('completed 不计打断', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    completeTask(db, task.id, { outcome: 'completed', summary: '完成', outboundTasks: [], artifacts: [] });
    expect(getTask(db, task.id).interruptionCount).toBe(0);
  });

  it('多次阻塞累加', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    completeTask(db, task.id, { outcome: 'waiting_input', summary: '?', outboundTasks: [], artifacts: [], question: '?' });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    completeTask(db, task.id, { outcome: 'waiting_input', summary: '??', outboundTasks: [], artifacts: [], question: '??' });
    expect(getTask(db, task.id).interruptionCount).toBe(2);
  });
});

describe('P0.3 assembleContext 注入验收标准', () => {
  it('有验收标准时注入 # 验收标准 段', () => {
    const { lead, p } = seed();
    const task = createTask(db, {
      projectId: p.id, title: 't', assigneeAgentId: lead.id,
      acceptanceCriteria: [{ id: 'ac_1', criterion: '不少于 3000 字' }],
    });
    const ctx = assembleContext(db, getTask(db, task.id));
    expect(ctx.systemPrompt).toContain('# 验收标准');
    expect(ctx.systemPrompt).toContain('不少于 3000 字');
    expect(ctx.systemPrompt).toContain('[ac_1]');
  });

  it('无验收标准时引导对齐（提示有界提问）', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    const ctx = assembleContext(db, getTask(db, task.id));
    expect(ctx.systemPrompt).toContain('尚未明确验收标准');
    expect(ctx.systemPrompt).toContain('一次性');
  });
});

describe('P1 开始段有界对齐', () => {
  it('requestAlignment 进入对齐态，alignment_rounds +1，interruption_count +1', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    const aligned = requestAlignment(db, task.id, '验收标准里"好"的定义是什么？');
    expect(aligned.state).toBe('waiting_input');
    expect(aligned.alignmentState).toBe('awaiting_alignment');
    expect(aligned.alignmentRounds).toBe(1);
    expect(aligned.interruptionCount).toBe(1);
  });

  it('answerAlignment 合并新增验收标准并清对齐态', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    requestAlignment(db, task.id, '缺验收标准');
    const answered = answerAlignment(db, task.id, '补充如下', [
      { id: 'ac_new', criterion: '测试通过' },
    ]);
    expect(answered.state).toBe('queued');
    expect(answered.alignmentState).toBeNull();
    expect(answered.acceptanceCriteria.some((a) => a.id === 'ac_new')).toBe(true);
  });

  it('answerAlignment 去重 by id（不重复加同 id）', () => {
    const { lead, p } = seed();
    const task = createTask(db, {
      projectId: p.id, title: 't', assigneeAgentId: lead.id,
      acceptanceCriteria: [{ id: 'ac_1', criterion: '原标准' }],
    });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    requestAlignment(db, task.id, '?');
    const answered = answerAlignment(db, task.id, '更新', [
      { id: 'ac_1', criterion: '新标准（同 id 应去重）' },
    ]);
    expect(answered.acceptanceCriteria.filter((a) => a.id === 'ac_1')).toHaveLength(1);
  });

  it(`达 MAX_ALIGNMENT_ROUNDS(${MAX_ALIGNMENT_ROUNDS}) 上报第一负责人`, () => {
    const c = createCompany(db, { name: '上报公司' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active' });
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    requestAlignment(db, task.id, '第 1 轮');
    // 回到 running 再发第 2 轮（应触发上报）
    db.prepare("UPDATE task SET state='running', alignment_state=NULL WHERE id=?").run(task.id);
    requestAlignment(db, task.id, '第 2 轮');
    // 应产生一个 [上报] 子 Task
    const escalations = db
      .prepare("SELECT id FROM task WHERE parent_task_id=? AND title LIKE '[上报]%'")
      .all(task.id) as { id: string }[];
    expect(escalations.length).toBe(1);
  });

  it('对齐态与执行追问（clarification_rounds）互不干扰', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    // 执行中追问
    completeTask(db, task.id, { outcome: 'waiting_input', summary: '?', outboundTasks: [], artifacts: [], question: '?' });
    expect(getTask(db, task.id).clarificationRounds).toBe(0); // 未回答前不 +1
    expect(getTask(db, task.id).alignmentRounds).toBe(0);
    // 开始段对齐是独立计数
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    requestAlignment(db, task.id, '对齐');
    expect(getTask(db, task.id).alignmentRounds).toBe(1);
    expect(getTask(db, task.id).clarificationRounds).toBe(0);
  });
});

describe('P2 验收对照判定', () => {
  it('completeTask(completed) 写回 acceptanceMet', () => {
    const { lead, p } = seed();
    const task = createTask(db, {
      projectId: p.id, title: 't', assigneeAgentId: lead.id,
      acceptanceCriteria: [
        { id: 'ac_1', criterion: 'A' },
        { id: 'ac_2', criterion: 'B' },
      ],
    });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    completeTask(db, task.id, {
      outcome: 'completed', summary: '完成',
      outboundTasks: [], artifacts: [],
      acceptanceMet: [
        { id: 'ac_1', met: true },
        { id: 'ac_2', met: false },
      ],
    });
    const got = getTask(db, task.id);
    expect(got.acceptanceCriteria.find((a) => a.id === 'ac_1')!.met).toBe(true);
    expect(got.acceptanceCriteria.find((a) => a.id === 'ac_2')!.met).toBe(false);
  });

  it('business-review 返工 Task 继承原 Task 的 acceptanceCriteria', () => {
    const { c, lead, p } = seed();
    const task = createTask(db, {
      projectId: p.id, title: '原稿', assigneeAgentId: lead.id,
      acceptanceCriteria: [{ id: 'ac_1', criterion: '人物设定完整' }],
    });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    const review = submitBusinessReview(db, {
      companyId: c.id, projectId: p.id, taskId: task.id, employeeId: lead.id,
      reviewKind: 'character', subjectId: 's1', subjectSnapshot: {}, title: '人物',
    });
    const decided = decideBusinessReview(db, review.id, { decision: 'changes_requested', feedback: '人物单薄' });
    expect(decided.reworkTaskId).not.toBeNull();
    const rework = getTask(db, decided.reworkTaskId!);
    expect(rework.acceptanceCriteria.some((a) => a.id === 'ac_1')).toBe(true);
    expect(rework.acceptanceCriteria[0]!.criterion).toBe('人物设定完整');
  });
});
