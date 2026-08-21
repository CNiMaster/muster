/**
 * 经验库（X1/X2）集成测试。
 *
 * 验证：
 * - cause/tags 写入透传：createMemoryCandidate → approve → entry 全链携带；非法 cause 容错为空不阻断。
 * - pull 检索：searchMemory 按 tag/cause 过滤命中；白名单外的 tag 输入被归一化（防 LIKE 通配注入）。
 * - push 零变化：loadContextMemories 结果不因 tags 有无而变（标签不进注入路径）。
 * - 跨项目晋升：同 cause + 高词元重叠 + ≥2 项目 → workspace 候选（pending 不自动入库）；幂等（同锚只提一次）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent, getAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, completeTask } from '../../src/server/domain/task';
import {
  createMemoryCandidate,
  approveMemoryCandidate,
  searchMemory,
  loadContextMemories,
  normalizeMemoryTags,
  MEMORY_CAUSES,
} from '../../src/server/domain/memory';
import { maybePromoteCrossProjectLessons } from '../../src/server/domain/reflection';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

function seed() {
  const c = restoreWorkbench(db, { id: 'wb_exp_1', name: '公司' });
  const lead = createAgent(db, { companyId: c.id, name: '干员', role: 'lead' });
  const p1 = createProject(db, { companyId: c.id, name: '项目一', rootDir: '/tmp/e1', firstAgentId: lead.id, initialState: 'active' });
  const p2 = createProject(db, { companyId: c.id, name: '项目二', rootDir: '/tmp/e2', firstAgentId: lead.id, initialState: 'active' });
  return { c, lead, p1, p2 };
}

function approvedEntry(profileId: string, projectId: string, content: string, opts: { cause?: string; tags?: string[]; fingerprint?: string } = {}) {
  const candidate = createMemoryCandidate(db, {
    profileId, scope: 'project', projectId, content,
    author: 'agent', confidence: 0.9, canInfluence: true,
    ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
    ...(opts.tags ? { tags: opts.tags } : {}),
    ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
  });
  return approveMemoryCandidate(db, candidate.id, 'user');
}

describe('cause/tags 写入透传（X1）', () => {
  it('候选→入库全链携带；非法 cause 容错为空；标签归一化小写 cap5', () => {
    const { lead, p1 } = seed();
    const entry = approvedEntry(lead.profileId, p1.id, '部署前必须先跑迁移演练', { cause: 'method', tags: ['部署', 'Migration', 'DB'] });
    expect(entry.cause).toBe('method');
    expect(entry.tags).toEqual(['部署', 'migration', 'db']);

    const bad = approvedEntry(lead.profileId, p1.id, '未归因经验', { cause: 'weather' });
    expect(bad.cause).toBeNull();

    expect(normalizeMemoryTags(['A', 'a', 'B', 'C', 'D', 'E', 'F'])).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect([...MEMORY_CAUSES]).toEqual(['model', 'method', 'context', 'tool']);
  });
});

describe('pull 检索过滤（X1）', () => {
  it('tag/cause 命中过滤；tag 输入白名单归一化（% 通配被剥除）', () => {
    const { lead, p1 } = seed();
    approvedEntry(lead.profileId, p1.id, '部署前先跑迁移演练，防止线上炸列', { cause: 'method', tags: ['deploy', 'migration'] });
    approvedEntry(lead.profileId, p1.id, '上下文不足时先追问再开工', { cause: 'context', tags: ['alignment'] });

    const byTag = searchMemory(db, { profileId: lead.profileId, query: '部署', projectId: p1.id, tag: 'deploy' });
    expect(byTag).toHaveLength(1);
    expect(byTag[0]!.tags).toContain('deploy');

    const byCause = searchMemory(db, { profileId: lead.profileId, query: '追问', projectId: p1.id, cause: 'context' });
    expect(byCause).toHaveLength(1);

    const wrongTag = searchMemory(db, { profileId: lead.profileId, query: '部署', projectId: p1.id, tag: '%de%' });
    expect(wrongTag).toHaveLength(0); // % 被剥除 → 按字面 de 过滤不命中

    // push 零变化：标签不进注入路径
    const injected = loadContextMemories(db, { profileId: lead.profileId, projectId: p1.id });
    expect(injected.length).toBe(2);
  });
});

describe('跨项目晋升（X2）', () => {
  it('同 cause + 高重叠 + ≥2 项目 → workspace 候选（pending）；幂等同锚只提一次', () => {
    const { lead, p1, p2 } = seed();
    approvedEntry(lead.profileId, p1.id, '发布前必须在副本库跑全量迁移演练，空库测试会掩盖真实库缺列问题', { cause: 'method', tags: ['migration'] });
    approvedEntry(lead.profileId, p2.id, '发布前在副本库跑全量迁移演练，空库测试掩盖真实库缺列问题，必须演练', { cause: 'method', tags: ['migration'] });
    // 不同 cause 的近邻不应触发
    approvedEntry(lead.profileId, p2.id, '模型看不清长表格数据属于上下文缺失，先补摘要再开工', { cause: 'context', tags: ['alignment'] });

    const promotedId = maybePromoteCrossProjectLessons(db);
    expect(promotedId).not.toBeNull();
    const cand = db.prepare('SELECT scope, status, cause, tags_json FROM memory_candidate WHERE id=?').get(promotedId!) as {
      scope: string; status: string; cause: string | null; tags_json: string;
    };
    expect(cand.scope).toBe('workspace');
    expect(cand.status).toBe('pending'); // 审核制：不自动入库
    expect(cand.cause).toBe('method');
    expect(JSON.parse(cand.tags_json)).toContain('晋升建议');

    // 幂等：再跑不重提（同锚 fingerprint 去重）
    expect(maybePromoteCrossProjectLessons(db)).toBeNull();
    void getAgent;
  });

  it('单一项目的经验不晋升', () => {
    const { lead, p1 } = seed();
    approvedEntry(lead.profileId, p1.id, '部署前先跑迁移演练防止炸列', { cause: 'method' });
    expect(maybePromoteCrossProjectLessons(db)).toBeNull();
    void completeTask; void createTask;
  });
});
