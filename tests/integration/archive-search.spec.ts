/**
 * 蓝图组织重构 批次2：跨项目归档检索集成测试。
 *
 * 验证：
 * - searchArchive 命中三类来源（记忆/调研摘要/成果元数据）并带来源项目标注。
 * - 排除当前项目（excludeProjectId）：只给旧档。
 * - 公司隔离：别家公司的归档不泄露。
 * - assembleContext 注入「# 相关旧档」；无命中时不注入（回归）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject, updateProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { createMemoryCandidate, approveMemoryCandidate } from '../../src/server/domain/memory';
import { searchArchive } from '../../src/server/domain/archive';
import { assembleContext } from '../../src/server/executors/context';
import { makeTestDb } from './setup';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

function seed() {
  const c = createCompany(db, { name: '公司' });
  const agent = createAgent(db, { companyId: c.id, name: '员工', role: 'lead' });
  // 旧项目（有经验记忆 + 调研摘要 + 成果）+ 当前项目
  const old = createProject(db, { companyId: c.id, name: '旧项目', rootDir: '/tmp/old', firstAgentId: agent.id, initialState: 'active' });
  const current = createProject(db, { companyId: c.id, name: '当前项目', rootDir: '/tmp/cur', firstAgentId: agent.id, initialState: 'active' });
  return { c, agent, old, current };
}

function seedArchive({ c, agent, old }: ReturnType<typeof seed>) {
  // 旧项目的经验记忆（已批准，project scope）
  const mem = createMemoryCandidate(db, {
    profileId: agent.profileId, scope: 'project', companyId: c.id, projectId: old.id,
    content: '落地页转化优化必须先做 A/B 测试再全量', author: 'user', confidence: 1, canInfluence: true,
  });
  approveMemoryCandidate(db, mem.id, 'user');
  // 旧项目的调研摘要（settings.onboarding.research.summary）
  updateProject(db, old.id, {
    settings: { onboarding: { research: { summary: '竞品调研：落地页首屏转化率是核心指标', candidateSkills: [], candidateTools: [] } } },
  });
  // 旧项目的成果元数据（直接落表：本测试只关心检索，不走 publish 管线）
  db.prepare(
    `INSERT INTO artifact (id, project_id, kind, path, owner_agent_id, merge_strategy, props_json, created_at, updated_at)
     VALUES ('art_test_1', ?, 'doc', 'reports/落地页优化报告.md', ?, 'three_way', '{}', ?, ?)`,
  ).run(old.id, agent.id, new Date().toISOString(), new Date().toISOString());
}

describe('searchArchive 跨项目归档检索', () => {
  it('命中三类来源（记忆/调研/成果），带来源项目标注', () => {
    const ctx = seed();
    seedArchive(ctx);
    const hits = searchArchive(db, { companyId: ctx.c.id, excludeProjectId: ctx.current.id, query: '落地页转化' });
    expect(hits.some((h) => h.kind === 'memory' && h.text.includes('A/B 测试'))).toBe(true);
    expect(hits.some((h) => h.kind === 'research' && h.text.includes('首屏转化率'))).toBe(true);
    expect(hits.some((h) => h.kind === 'artifact' && h.text.includes('落地页优化报告'))).toBe(true);
    expect(hits.every((h) => h.projectName === '旧项目')).toBe(true);
  });

  it('excludeProjectId：当前项目的归档不进结果（只给旧档）', () => {
    const ctx = seed();
    seedArchive(ctx);
    // 在当前项目也放一条同名经验
    const cur = createMemoryCandidate(db, {
      profileId: ctx.agent.profileId, scope: 'project', companyId: ctx.c.id, projectId: ctx.current.id,
      content: '当前项目的落地页转化经验', author: 'user', confidence: 1, canInfluence: true,
    });
    approveMemoryCandidate(db, cur.id, 'user');
    const hits = searchArchive(db, { companyId: ctx.c.id, excludeProjectId: ctx.current.id, query: '落地页' });
    expect(hits.some((h) => h.text.includes('当前项目的'))).toBe(false);
    expect(hits.some((h) => h.text.includes('A/B 测试'))).toBe(true);
  });

  it('公司隔离：别家公司的归档不泄露', () => {
    const ctx = seed();
    seedArchive(ctx);
    const other = createCompany(db, { name: '别家公司' });
    const otherAgent = createAgent(db, { companyId: other.id, name: '外人', role: 'lead' });
    const otherProject = createProject(db, { companyId: other.id, name: '别家项目', rootDir: '/tmp/other', firstAgentId: otherAgent.id, initialState: 'active' });
    const mem = createMemoryCandidate(db, {
      profileId: otherAgent.profileId, scope: 'project', companyId: other.id, projectId: otherProject.id,
      content: '别家公司的落地页机密经验', author: 'user', confidence: 1, canInfluence: true,
    });
    approveMemoryCandidate(db, mem.id, 'user');

    const hits = searchArchive(db, { companyId: ctx.c.id, query: '落地页' });
    expect(hits.some((h) => h.text.includes('别家公司'))).toBe(false);
  });

  it('待审批记忆不进归档（只检索已批准经验）', () => {
    const ctx = seed();
    createMemoryCandidate(db, {
      profileId: ctx.agent.profileId, scope: 'project', companyId: ctx.c.id, projectId: ctx.old.id,
      content: '未审批的落地页经验', author: 'agent', confidence: 0.6, canInfluence: true,
    });
    const hits = searchArchive(db, { companyId: ctx.c.id, query: '落地页' });
    expect(hits.some((h) => h.text.includes('未审批'))).toBe(false);
  });
});

describe('assembleContext 「# 相关旧档」注入', () => {
  it('当前任务命中旧项目归档 → 注入带来源标注的旧档段', () => {
    const ctx = seed();
    seedArchive(ctx);
    const task = createTask(db, { projectId: ctx.current.id, assigneeAgentId: ctx.agent.id, title: '优化落地页转化率' });
    const sp = assembleContext(db, task).systemPrompt;
    expect(sp).toContain('# 相关旧档');
    expect(sp).toContain('A/B 测试');
    expect(sp).toContain('旧项目');
  });

  it('无命中 → 不注入旧档段（回归：上下文无多余段落）', () => {
    const ctx = seed();
    const task = createTask(db, { projectId: ctx.current.id, assigneeAgentId: ctx.agent.id, title: '与归档无关的任务主题' });
    const sp = assembleContext(db, task).systemPrompt;
    expect(sp).not.toContain('# 相关旧档');
  });
});
