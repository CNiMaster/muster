/**
 * 蜂群专家团 + 派遣分级（批次5）：
 * - swarmPlan worker 指定 personaId → 工蜂任务穿戴人设（显式优先于蓝图自动匹配）
 * - 专家自主小额：建群快照限额 = 3 蜂/单层/$1，requester 落库
 * - 超限/已有活跃群 → 升级第一负责人（[蜂群请示] 任务，不建群）
 * - 匿名蜂不受影响
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createNovelCompany } from './setup';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask } from '../../src/server/domain/task';
import {
  materializeSwarm, createSwarmRun, countActiveSwarmsByRequester, escalateSwarmRequest,
  EXPERT_SWARM_LIMITS, getSwarmRun,
} from '../../src/server/domain/swarm';
import { listTasks } from '../../src/server/domain/task';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;
let projectId: string;

function makeTask(assigneeAgentId: string, title = '组织调研蜂群'): ReturnType<typeof createTask> {
  return createTask(db, {
    projectId,
    assigneeAgentId,
    title,
    inputProtocol: { trigger: 'test' },
  });
}

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  companyId = r.company.id;
  const project = createProject(db, { companyId, name: 'p', rootDir: '/tmp/se', firstAgentId: r.agents.lead.id, initialState: 'active' });
  projectId = project.id;
});

describe('swarm expert team', () => {
  it('混合专家蜂群：worker personaId 穿戴到工蜂任务，显式优先', () => {
    const lead = db.prepare("SELECT id FROM agent_definition WHERE company_id=? AND role='lead'").get(companyId) as { id: string };
    const source = makeTask(lead.id);
    const plan = {
      goal: '写一份行业报告',
      workers: [
        { title: '收集资料', brief: '调研竞品', personaId: 'publishing/publishing-fact-checker' },
        { title: '撰写正文', brief: '成稿', personaId: 'publishing/publishing-copy-editor' },
      ],
    };
    const materialized = materializeSwarm(db, source, plan, { requesterAgentId: lead.id });
    expect(materialized.beeTaskIds).toHaveLength(2);
    const bees = listTasks(db, projectId).filter((t) => t.personaId);
    expect(bees).toHaveLength(2);
    const research = bees.find((t) => t.title === '收集资料')!;
    expect(research.personaId).toBe('publishing/publishing-fact-checker');
    const writing = bees.find((t) => t.title === '撰写正文')!;
    expect(writing.personaId).toBe('publishing/publishing-copy-editor');
  });

  it('不存在的 personaId 优雅降级为匿名', () => {
    const lead = db.prepare("SELECT id FROM agent_definition WHERE company_id=? AND role='lead'").get(companyId) as { id: string };
    const source = makeTask(lead.id);
    const materialized = materializeSwarm(db, source, { goal: 'g', workers: [{ title: 'x', brief: 'b', personaId: 'p_ghost' }] }, { requesterAgentId: lead.id });
    const bee = getTask(db, materialized.beeTaskIds[0]!);
    expect(bee.personaId).toBeNull();
  });

  it('专家自主：限额快照 3 蜂/单层/$1 且 requester 落库', () => {
    const expert = db.prepare("SELECT id FROM agent_definition WHERE company_id=? AND role='writer'").get(companyId) as { id: string };
    const source = makeTask(expert.id);
    const plan = { goal: 'g', workers: [{ title: 'a', brief: 'b' }, { title: 'c', brief: 'd' }] };
    const materialized = materializeSwarm(db, source, plan, { requesterAgentId: expert.id, limitsOverride: EXPERT_SWARM_LIMITS });
    const swarm = getSwarmRun(db, materialized.swarmId);
    expect(swarm.maxWidth).toBe(3);
    expect(swarm.maxDepth).toBe(1);
    expect(swarm.budgetUsd).toBe(1);
    // requester 落库 → 并发控制可查
    expect(countActiveSwarmsByRequester(db, expert.id)).toBe(1);
  });

  it('超限升级：超过 3 只不建群，改派 [蜂群请示] 给第一负责人', () => {
    const expert = db.prepare("SELECT id FROM agent_definition WHERE company_id=? AND role='writer'").get(companyId) as { id: string };
    const lead = db.prepare("SELECT id FROM agent_definition WHERE company_id=? AND role='lead'").get(companyId) as { id: string };
    const source = makeTask(expert.id);
    const plan = { goal: 'g', workers: [1, 2, 3, 4].map((i) => ({ title: `子题${i}`, brief: 'b' })) };
    const escalated = escalateSwarmRequest(db, {
      companyId, projectId, leadAgentId: lead.id, requesterAgentId: expert.id, requesterName: '写手', plan,
    });
    const requestTask = getTask(db, escalated.taskId);
    expect(requestTask.assigneeAgentId).toBe(lead.id);
    expect(requestTask.title).toContain('[蜂群请示]');
    expect(requestTask.inputProtocol.trigger).toBe('swarm_request');
    expect(requestTask.inputProtocol.planDigest as string).toContain('子题1');
    // 未建群
    expect(countActiveSwarmsByRequester(db, expert.id)).toBe(0);
    // 直接 createSwarmRun 也可记录 requester
    const run = createSwarmRun(db, { companyId, projectId, rootTaskId: source.id, goal: 'g', requesterAgentId: expert.id });
    expect(getSwarmRun(db, run.id).requesterAgentId).toBe(expert.id);
  });
});
