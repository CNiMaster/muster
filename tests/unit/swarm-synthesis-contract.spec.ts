import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, completeTask } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { validateSwarmSynthesisSummary } from '../../src/server/domain/swarm';
import { assembleContext } from '../../src/server/executors/context';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('蜂群收口结构契约（批次 D）', () => {
  it('validateSwarmSynthesisSummary 校验：三段齐全返回 valid: true', () => {
    const summary = `
## 结论
所有子任务均已完成，架构已稳定。

## 分歧
关于数据库选用 SQLite 还是 Postgres，最终裁决采用 SQLite 本地嵌入模式。

## 风险
高并发写操作可能引起库锁等待，需后续压测观察。
`;
    const res = validateSwarmSynthesisSummary(summary);
    expect(res.valid).toBe(true);
    expect(res.missingSections).toHaveLength(0);
    expect(res.annotatedSummary).toBe(summary);
  });

  it('validateSwarmSynthesisSummary 校验：显式写明「无分歧」同样判定通过', () => {
    const summary = `
## 结论
微前端集成完成。

## 分歧
团队在技术选型上达成完全一致，本次无分歧。

## 风险
暂无明显阻断性风险。
`;
    const res = validateSwarmSynthesisSummary(summary);
    expect(res.valid).toBe(true);
    expect(res.missingSections).toHaveLength(0);
    expect(res.annotatedSummary).toBe(summary);
  });

  it('validateSwarmSynthesisSummary 校验：缺段时返回 missingSections 与标注前缀', () => {
    const summary = `
## 结论
完成了所有模块重构。
`;
    const res = validateSwarmSynthesisSummary(summary);
    expect(res.valid).toBe(false);
    expect(res.missingSections).toEqual(['分歧', '风险']);
    expect(res.annotatedSummary).toContain('[收口契约不完整：缺分歧、风险段]');
  });

  it('completeTask 对汇总任务执行契约校验与违约留痕（不重派不阻塞）', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_sc_1', name: '工作台' });
    const agent = createAgent(db, { companyId: workbench.id, name: '调度员', role: 'dispatcher', isSystem: true });
    const project = createProject(db, { companyId: workbench.id, name: '项目' });

    // 1. 合规汇总任务
    const tValid = createTask(db, {
      projectId: project.id,
      assigneeAgentId: agent.id,
      title: '[蜂群汇总] 调研任务',
      inputProtocol: { swarmSynthesis: true },
    });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(tValid.id);
    const validSummary = '【结论】达成预期目标。\n【分歧】无分歧。\n【风险】无风险。';
    const completedValid = completeTask(db, tValid.id, { outcome: 'completed', summary: validSummary });
    expect(completedValid.summary).toBe(validSummary);
    const validEvents = listTaskEvents(db, tValid.id);
    expect(validEvents.some((e) => e.kind === 'synthesis_contract_violation')).toBe(false);

    // 2. 违约汇总任务（缺段）
    const tInvalid = createTask(db, {
      projectId: project.id,
      assigneeAgentId: agent.id,
      title: '[蜂群汇总] 架构讨论',
      inputProtocol: { swarmSynthesis: true },
    });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(tInvalid.id);
    const incompleteSummary = '【结论】架构重构已完成。';
    const completedInvalid = completeTask(db, tInvalid.id, { outcome: 'completed', summary: incompleteSummary });
    expect(completedInvalid.summary).toContain('[收口契约不完整：缺分歧、风险段]');
    expect(completedInvalid.state).toBe('completed'); // 不阻塞，状态正常完成

    const invalidEvents = listTaskEvents(db, tInvalid.id);
    const violationEvent = invalidEvents.find((e) => e.kind === 'synthesis_contract_violation');
    expect(violationEvent).toBeDefined();
    expect(violationEvent?.payload).toEqual(
      expect.objectContaining({
        missingSections: ['分歧', '风险'],
        rawSummary: incompleteSummary,
      }),
    );
  });

  it('context.ts 汇总任务上下文注入 # 蜂群收口结构契约 教学', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_sc_ctx', name: '工作台' });
    const agent = createAgent(db, { companyId: workbench.id, name: '调度员', role: 'dispatcher', isSystem: true });
    const project = createProject(db, { companyId: workbench.id, name: '项目' });

    const synthesisTask = createTask(db, {
      projectId: project.id,
      assigneeAgentId: agent.id,
      title: '[蜂群汇总] 全面评审',
      inputProtocol: { swarmSynthesis: true },
    });

    const ctx = assembleContext(db, synthesisTask);
    expect(ctx.systemPrompt).toContain('# 蜂群收口结构契约');
    expect(ctx.systemPrompt).toContain('「## 结论」');
    expect(ctx.systemPrompt).toContain('「## 分歧」');
    expect(ctx.systemPrompt).toContain('「## 风险」');
  });
});
