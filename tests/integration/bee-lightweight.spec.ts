/**
 * 批次 H.0：工蜂轻量化——共享常驻档案、无 per-bee 档案/Agent Home churn、轻量回收。
 *
 * 用工定调（2026-08-22）：temp-worker 基建专属临时专家与 B2B 外包；普通工蜂=最小 agent 行
 * （role=swarm-worker + 共享档案 ap_worker_bee_shared + hidden + deny 档 + primary 线程）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, listTasks } from '../../src/server/domain/task';
import { materializeSwarm, createWorkerBee, dismissWorkerBee, releaseSwarmBees, SWARM_WORKER_ROLE } from '../../src/server/domain/swarm';
import { ensureSystemAgents } from '../../src/server/domain/system-agents';
import { clockIn, restoreWorkbench } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

function fixture() {
  const company = restoreWorkbench(db, { id: 'wb_bee_h0', name: 'co' });
  const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
  const project = createProject(db, {
    companyId: company.id,
    name: 'p1',
    rootDir: makeTempGitRepo(),
    firstAgentId: lead.id,
    initialState: 'active',
  });
  clockIn(db);
  const sys = ensureSystemAgents(db);
  return { company, lead, project, ...sys };
}

describe('工蜂轻量化（批次 H.0）', () => {
  it('孵化 N 只蜂只存在一个共享档案（不再 per-bee 建 agent_profile）', () => {
    const { project, lead } = fixture();
    const b1 = createWorkerBee(db, { projectId: project.id, requesterAgentId: lead.id, index: 0 });
    const b2 = createWorkerBee(db, { projectId: project.id, requesterAgentId: lead.id, index: 1 });
    const profiles = db
      .prepare(`SELECT DISTINCT a.profile_id AS pid FROM agent_definition a WHERE a.id IN (?, ?)`)
      .all(b1, b2) as Array<{ pid: string }>;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.pid).toBe('ap_worker_bee_shared');
    // 共享档案常驻（非 temp-only，dismiss 永不误删）
    const shared = db.prepare('SELECT is_temp_only FROM agent_profile WHERE id=?').get('ap_worker_bee_shared') as { is_temp_only: number | null };
    expect(shared.is_temp_only ?? 0).toBe(0);
    // 蜂任职：temp+active+hidden
    const emp = db.prepare('SELECT employment_type, temp_status, hidden FROM company_employee WHERE legacy_agent_id=?').get(b1) as { employment_type: string; temp_status: string; hidden: number };
    expect(emp).toMatchObject({ employment_type: 'temp', temp_status: 'active', hidden: 1 });
  });

  it('轻量回收：只删 agent 行（级联任职/线程），共享档案保留，任务审计不受影响；非蜂拒删', () => {
    const { project, lead } = fixture();
    const bee = createWorkerBee(db, { projectId: project.id, requesterAgentId: lead.id, index: 0 });
    // 蜂任务真实链路带 swarmManaged（蜂为 hidden 执行体，只受直属调度控制，走该豁免）
    const task = createTask(db, {
      projectId: project.id,
      title: '蜂任务',
      assigneeAgentId: bee,
      dispatcherAgentId: lead.id,
      swarmManaged: true,
    });
    dismissWorkerBee(db, bee);
    expect(db.prepare('SELECT 1 FROM agent_definition WHERE id=?').get(bee)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM company_employee WHERE legacy_agent_id=?').get(bee)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM agent_profile WHERE id=?').get('ap_worker_bee_shared')).toBeDefined();
    // 任务审计保留（assignee 因 FK 置空）
    const row = db.prepare('SELECT assignee_agent_id, title FROM task WHERE id=?').get(task.id) as { assignee_agent_id: string | null; title: string };
    expect(row.assignee_agent_id).toBeNull();
    expect(row.title).toBe('蜂任务');
    // 非蜂（正式员工）拒绝轻量回收
    expect(() => dismissWorkerBee(db, lead.id)).toThrow();
  });

  it('releaseSwarmBees 走轻量回收：群关闭后蜂行消失、共享档案仍在、汇报审计保留', () => {
    const { project, lead, dispatcherAgentId } = fixture();
    const source = createTask(db, { projectId: project.id, title: '源任务', assigneeAgentId: lead.id, dispatcherAgentId: lead.id });
    const plan = {
      goal: '把调研拆两路',
      summary: '拆两路',
      workers: [
        { title: '子题A', instructions: '做A' },
        { title: '子题B', instructions: '做B' },
      ],
    };
    const m = materializeSwarm(db, source, plan, { requesterAgentId: lead.id });
    expect(m.beeTaskIds).toHaveLength(2);
    const beeIds = (listTasks(db, project.id) as Array<{ assigneeAgentId: string | null }>)
      .map((t) => t.assigneeAgentId)
      .filter((id): id is string => !!id && id !== lead.id && id !== dispatcherAgentId);
    expect(beeIds.length).toBeGreaterThanOrEqual(2);
    // 群关闭前置条件：蜂任务到达终态（在飞蜂只灰化不删是既有防御）
    db.prepare(`UPDATE task SET state='completed' WHERE swarm_id=?`).run(m.swarmId);
    releaseSwarmBees(db, m.swarmId);
    for (const id of beeIds) {
      expect(db.prepare('SELECT 1 FROM agent_definition WHERE id=?').get(id)).toBeUndefined();
    }
    expect(db.prepare('SELECT 1 FROM agent_profile WHERE id=?').get('ap_worker_bee_shared')).toBeDefined();
    // 蜂任务行保留（审计）
    const remaining = listTasks(db, project.id);
    expect(remaining.filter((t) => t.title === '子题A' || t.title === '子题B')).toHaveLength(2);
  });
});
