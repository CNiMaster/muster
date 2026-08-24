import { updateWorkbench, restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 能力缺口自愈——Researcher 咨询派发 集成测试（spec 2026-08-12 B2）。
 * 验证 opt-in 门控、节流、研究员选择与咨询子任务创建。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest, type DB } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { dispatchGapResearch } from '../../src/server/domain/gap-research';
import type { CapabilityGap } from '../../src/server/domain/tool-recommendation';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
  setDbForTest(db);
});

const GAPS: CapabilityGap[] = [
  { capabilityId: 'speech-to-text', purpose: '语音转文字', reason: '员工能力 speech-to-text 无任何已启用工具实现' },
];

describe('dispatchGapResearch（B2 缺口自愈，opt-in）', () => {
  it('默认 opt-in 未开启 → 不派发（零行为变化）', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '转写音频' });

    const r = dispatchGapResearch(db, task, GAPS);
    expect(r.dispatched).toBe(false);
    expect(r.reason).toMatch(/opt-in/);
  });

  it('opt-in 开启 + 在线研究员 → 派发咨询子任务并落事件', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_2', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    createAgent(db, { companyId: c.id, name: '研究员', role: 'researcher', skills: ['research'] });
    // 时钟上线：直接 update availability state
    db.prepare("UPDATE agent_definition SET availability_state='online' WHERE role IN ('lead','researcher')").run();
    updateWorkbench(db, { contractJson: { autoGapResearch: true } });
    const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '转写音频' });

    const r = dispatchGapResearch(db, task, GAPS);
    expect(r.dispatched).toBe(true);
    expect(r.researchTaskId).toBeTruthy();
    const evt = listTaskEvents(db, task.id).find((e) => e.kind === 'capability_gap_research_dispatched');
    expect(evt?.payload.researchTaskId).toBe(r.researchTaskId);
  });

  it('节流：同一 task 第二次不重复派发', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_3', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    createAgent(db, { companyId: c.id, name: '研究员', role: 'researcher', skills: ['research'] });
    db.prepare("UPDATE agent_definition SET availability_state='online' WHERE role IN ('lead','researcher')").run();
    updateWorkbench(db, { contractJson: { autoGapResearch: true } });
    const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '转写音频' });

    const r1 = dispatchGapResearch(db, task, GAPS);
    expect(r1.dispatched).toBe(true);
    const r2 = dispatchGapResearch(db, task, GAPS);
    expect(r2.dispatched).toBe(false);
    expect(r2.reason).toMatch(/已派过/);
  });

  it('opt-in 开启但无在线研究员/负责人 → 不派发', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_4', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    updateWorkbench(db, { contractJson: { autoGapResearch: true } });
    // lead 默认 offline，无人在线
    const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '转写音频' });

    const r = dispatchGapResearch(db, task, GAPS);
    expect(r.dispatched).toBe(false);
    expect(r.reason).toMatch(/无在线/);
  });
});
