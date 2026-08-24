/**
 * 常驻专家记忆快照生成器（2026-08-24 蜂群分身专项）：
 * 纯 DB 读薄摘要（compaction_summary + 最近 5 个已完成任务）、800 字硬预算、
 * 无 thread / 无可聚合内容时返回 null（分身退化为纯人设穿戴，不阻断）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { buildSpecialistSnapshot, SNAPSHOT_MAX_CHARS } from '../../src/server/domain/specialist-snapshot';
import { ensurePersonaArchiveProfile } from '../../src/server/domain/agent-profile';
import { createMemoryCandidate } from '../../src/server/domain/memory';
import { clockIn, restoreWorkbench } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

function fixture() {
  const company = restoreWorkbench(db, { id: 'wb_snp', name: 'co' });
  const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
  const project = createProject(db, {
    companyId: company.id,
    name: 'p1',
    rootDir: makeTempGitRepo(),
    firstAgentId: lead.id,
    initialState: 'active',
  });
  clockIn(db);
  return { company, lead, project };
}

describe('buildSpecialistSnapshot', () => {
  it('无 primary thread → null（新落成常驻专家没建线程——快照优雅退化）', () => {
    const { lead } = fixture();
    const r = buildSpecialistSnapshot(db, lead.id);
    expect(r.snapshot).toBeNull();
    expect(r.sourceThreadId).toBeNull();
  });

  it('compaction_summary + 最近完成任务 → 两段快照', () => {
    const { company, lead, project } = fixture();
    const thread = ensurePrimaryThread(db, project.id, lead.id);
    db.prepare('UPDATE project_agent_thread SET compaction_summary=? WHERE id=?').run('偏好用 Rust 写原型；交付必须带测试。', thread.id);
    // 直接种完成任务（绕开状态机：completeTask 要求 running，快照只关心 completed+summary 字段）
    createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '做一次性能基线' });
    db.prepare("UPDATE task SET state='completed', summary=? WHERE assignee_agent_id=? AND title='做一次性能基线'").run('基线 QPS 1200，瓶颈在索引', lead.id);
    void company;

    const r = buildSpecialistSnapshot(db, lead.id);
    expect(r.snapshot).toContain('【经验摘要】');
    expect(r.snapshot).toContain('Rust 写原型');
    expect(r.snapshot).toContain('【最近完成】');
    expect(r.snapshot).toContain('基线 QPS 1200');
    expect(r.sourceThreadId).toBe(thread.id);
  });

  it('超预算截断且不超过硬上限（含截断省略号）', () => {
    const { lead, project } = fixture();
    const thread = ensurePrimaryThread(db, project.id, lead.id);
    db.prepare('UPDATE project_agent_thread SET compaction_summary=? WHERE id=?').run('长'.repeat(SNAPSHOT_MAX_CHARS + 500), thread.id);
    const r = buildSpecialistSnapshot(db, lead.id);
    expect(r.snapshot!.length).toBeLessThanOrEqual(SNAPSHOT_MAX_CHARS + 1);
    expect(r.snapshot!.endsWith('…')).toBe(true);
  });

  it('有 thread 但无摘要无完成任务 → null（不产出空快照段）', () => {
    const { lead, project } = fixture();
    const thread = ensurePrimaryThread(db, project.id, lead.id);
    const r = buildSpecialistSnapshot(db, lead.id);
    expect(r.snapshot).toBeNull();
    expect(r.sourceThreadId).toBe(thread.id);
  });
});

describe('A7：快照补人设方法论段', () => {
  it('personaId 命中的 skill/CRAFT 记忆进快照（方法论段最优先，不传 personaId 则不注入）', () => {
    const { lead, project } = fixture();
    const thread = ensurePrimaryThread(db, project.id, lead.id);
    db.prepare('UPDATE project_agent_thread SET compaction_summary=? WHERE id=?').run('经验摘要正文', thread.id);
    // 人设方法论：挂人设档案宿主 + persona_key（与蜂群分身穿戴链路同构）
    const archive = ensurePersonaArchiveProfile(db);
    const personaId = 'product/front-end-engineer';
    for (const text of ['写 PRD 先核对数据口径', '组件改动先跑视觉回归']) {
      createMemoryCandidate(db, {
        profileId: archive, scope: 'skill', personaKey: personaId, content: text,
        author: 'agent', confidence: 0.9, canInfluence: true, allowAutoApprove: true,
      });
    }

    const r = buildSpecialistSnapshot(db, lead.id, personaId);
    expect(r.snapshot).toContain('【人设方法论】');
    expect(r.snapshot).toContain('写 PRD 先核对数据口径');
    // 方法论段在经验摘要之前（截断时保方法论）
    expect(r.snapshot!.indexOf('【人设方法论】')).toBeLessThan(r.snapshot!.indexOf('【经验摘要】'));

    // 不传 personaId：不注入方法论段（向后兼容）
    const plain = buildSpecialistSnapshot(db, lead.id);
    expect(plain.snapshot).not.toContain('【人设方法论】');
  });
});
