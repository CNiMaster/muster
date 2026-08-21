/**
 * B1 链路双指向 集成测试。
 *
 * 验证：
 * - finalReturnAgentId：root 缺省回落负责人；子任务继承链头值；下游显式覆盖被阻断
 *   （final_return_violation 留痕 + 链头值生效）。
 * - chainHistory：root 自身一跳；子任务 = 父链 + 本跳。
 * - 意图契约（intentAnchor/nonGoals/failurePolicy）：子任务未声明时继承，显式声明不被覆盖。
 * - outbound reason/division → 子任务 inputProtocol.chainReason/chainDivision（不占系统 reason 键）。
 * - [子任务完成]：普通子任务完成写回直接请求者（父任务消息流）；父任务依赖恢复。
 * - 验收 PASS → final_return_routed 事件 + 项目对话播报点名终返（链路法：验收→finalReturn→负责人→用户）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, completeTask } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { listTaskMessages } from '../../src/server/domain/task-message';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { ensureAcceptanceOfficer } from '../../src/server/domain/acceptance-officer';
import {
  maybeTriggerAcceptanceReview,
  handleAcceptanceReviewTaskCompleted,
} from '../../src/server/domain/acceptance-review';
import type { ChainHop } from '../../src/shared/types';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

function seed() {
  const c = restoreWorkbench(db, { id: 'wb_chain_1', name: '公司' });
  const lead = createAgent(db, { companyId: c.id, name: '干员', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir: '/tmp/chain', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

function running(taskId: string): void {
  db.prepare("UPDATE task SET state='running' WHERE id=?").run(taskId);
}

function protoOf(taskId: string): Record<string, unknown> {
  return (getTask(db, taskId).inputProtocol ?? {}) as Record<string, unknown>;
}

describe('finalReturnAgentId 终返继承', () => {
  it('root 缺省回落负责人；chainHistory 自身一跳', () => {
    const { lead, p } = seed();
    const t = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '根任务' });
    expect(protoOf(t.id).finalReturnAgentId).toBe(lead.id);
    const hist = protoOf(t.id).chainHistory as ChainHop[];
    expect(hist).toHaveLength(1);
    expect(hist[0]!.taskId).toBe(t.id);
    expect(hist[0]!.agentId).toBe(lead.id);
  });

  it('root 显式终返生效；子任务继承链头值，下游覆盖被阻断（violation 留痕）', () => {
    const { c, lead, p } = seed();
    const specialist = createAgent(db, { companyId: c.id, name: '专家A', role: 'specialist' });
    ensurePrimaryThread(db, p.id, specialist.id);
    const root = createTask(db, {
      projectId: p.id, assigneeAgentId: specialist.id, title: '根任务',
      finalReturnAgentId: lead.id,
    });
    expect(protoOf(root.id).finalReturnAgentId).toBe(lead.id);

    // 子任务试图把终返改成自己 → 阻断，链头值生效
    const child = createTask(db, {
      projectId: p.id, parentTaskId: root.id, assigneeAgentId: lead.id, title: '子任务',
      inputProtocol: { finalReturnAgentId: specialist.id },
    });
    expect(protoOf(child.id).finalReturnAgentId).toBe(lead.id);
    expect(listTaskEvents(db, child.id).some((e) => e.kind === 'final_return_violation')).toBe(true);
    const hist = protoOf(child.id).chainHistory as ChainHop[];
    expect(hist).toHaveLength(2);
    expect(hist[1]!.taskId).toBe(child.id);
    expect(hist[0]!.taskId).toBe(root.id);
  });
});

describe('意图契约继承', () => {
  it('intentAnchor/nonGoals 子任务未声明时继承；显式声明不被覆盖', () => {
    const { c, lead, p } = seed();
    const specialist = createAgent(db, { companyId: c.id, name: '专家A', role: 'specialist' });
    ensurePrimaryThread(db, p.id, specialist.id);
    const root = createTask(db, {
      projectId: p.id, assigneeAgentId: specialist.id, title: '根任务',
      inputProtocol: { intentAnchor: { goal: '提升落地页转化' }, nonGoals: ['不改商业模式'] },
    });
    const child = createTask(db, {
      projectId: p.id, parentTaskId: root.id, assigneeAgentId: lead.id, title: '子任务',
    });
    expect(protoOf(child.id).intentAnchor).toEqual({ goal: '提升落地页转化' });
    expect(protoOf(child.id).nonGoals).toEqual(['不改商业模式']);

    const ownChild = createTask(db, {
      projectId: p.id, parentTaskId: root.id, assigneeAgentId: lead.id, title: '自带意图的子任务',
      inputProtocol: { intentAnchor: { goal: '只做文案润色' } },
    });
    expect(protoOf(ownChild.id).intentAnchor).toEqual({ goal: '只做文案润色' });
  });
});

describe('outbound 转派与 [子任务完成] 回写', () => {
  it('reason/division 落子任务 chainReason/chainDivision；子完成回写直接请求者并恢复父依赖', () => {
    const { c, lead, p } = seed();
    const a = createAgent(db, { companyId: c.id, name: '专家A', role: 'specialist' });
    const b = createAgent(db, { companyId: c.id, name: '专家B', role: 'specialist' });
    ensurePrimaryThread(db, p.id, a.id);
    ensurePrimaryThread(db, p.id, b.id);

    const parent = createTask(db, { projectId: p.id, assigneeAgentId: a.id, title: '父任务' });
    running(parent.id);
    completeTask(db, parent.id, {
      outcome: 'waiting_dependency',
      summary: '拆出校对子任务',
      outboundTasks: [{
        recipientAgentId: b.id, protocolId: 'proto', title: '子任务校对',
        payload: { scope: '第三章' }, priority: 5,
        reason: '需要专项校对', division: '负责第三章校对',
      }],
      artifacts: [],
    });
    const childId = (db.prepare("SELECT id FROM task WHERE title='子任务校对'").get() as { id: string }).id;
    const child = getTask(db, childId);
    expect(child.parentTaskId).toBe(parent.id);
    expect(protoOf(childId).chainReason).toBe('需要专项校对');
    expect(protoOf(childId).chainDivision).toBe('负责第三章校对');
    // 子任务继承链头终返（root 默认负责人）
    expect(protoOf(childId).finalReturnAgentId).toBe(lead.id);

    // 子任务完成 → [子任务完成] 写回父任务消息流 + 父依赖恢复
    running(childId);
    completeTask(db, childId, { outcome: 'completed', summary: '校对完成，改了 3 处', outboundTasks: [], artifacts: [] });
    const msgs = listTaskMessages(db, parent.id);
    expect(msgs.some((m) => m.role === 'dispatch' && m.content.startsWith('[子任务完成]') && m.content.includes('校对完成'))).toBe(true);
    expect(getTask(db, parent.id).state).toBe('queued');
  });
});

describe('验收 PASS 终拔回流', () => {
  it('final_return_routed 留痕 + 项目对话播报点名终返（默认负责人）', () => {
    const { c, lead, p } = seed();
    void lead;
    const specialist = createAgent(db, { companyId: c.id, name: '专家A', role: 'specialist' });
    ensurePrimaryThread(db, p.id, specialist.id);
    const source = createTask(db, {
      projectId: p.id, assigneeAgentId: specialist.id, title: '有标准的任务',
      acceptanceCriteria: [{ id: 'ac_1', criterion: '产物存在' }],
    });
    const review = maybeTriggerAcceptanceReview(db, source)!;
    expect(review).not.toBeNull();
    void ensureAcceptanceOfficer;
    running(review.id);
    completeTask(db, review.id, { outcome: 'completed', summary: 'VERDICT=PASS\nCONFIDENCE=0.9\n达标', outboundTasks: [], artifacts: [] });
    handleAcceptanceReviewTaskCompleted(db, getTask(db, review.id));

    expect(listTaskEvents(db, source.id).some((e) => e.kind === 'final_return_routed')).toBe(true);
    const broadcast = db.prepare(
      "SELECT content FROM conversation_message WHERE scope_kind='project' AND content LIKE '[验收通过·回流]%'",
    ).get() as { content: string } | undefined;
    expect(broadcast?.content).toContain('干员');
  });
});
