/**
 * 能力质量反馈闭环 + 跨类型缺口检测 集成测试
 * (spec 2026-08-12-capability-marketplace-quality-loop B2/B3)。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest, type DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import {
  recordCapabilityUsage,
  getCapabilityQuality,
  getAllCapabilityQuality,
} from '../../src/server/domain/capability-quality';
import { findCapabilityGaps, performCapabilityPrecheck } from '../../src/server/domain/tool-recommendation';
import { listTaskEvents } from '../../src/server/domain/task-event';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
  setDbForTest(db);
});

function fixture() {
  const c = createCompany(db, { name: 'co' });
  const worker = createAgent(db, { companyId: c.id, name: 'worker', role: 'worker' });
  const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: worker.id, initialState: 'active' });
  return { c, worker, project };
}

function insertBinding(_companyId: string, capabilityId: string, toolIds: string[]) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO capability_binding (id, employee_id, scope, scope_key, capability_id, skill_ids_json, purpose, load_when, created_at, updated_at)
     VALUES (?, NULL, 'role', 'worker', ?, '[]', '测试能力', 'always', ?, ?)`,
  ).run(`cb_${capabilityId}`, capabilityId, now, now);
  db.prepare('UPDATE capability_binding SET recommended_tool_ids_json = ? WHERE id = ?').run(JSON.stringify(toolIds), `cb_${capabilityId}`);
}

function insertActiveTool(id: string, capabilityId: string) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tool_registry (id, capability_id, implementation, title, file_path, created_at, updated_at)
     VALUES (?, ?, 'local', ?, ?, ?, ?)`,
  ).run(id, capabilityId, id, `${id}.md`, now, now);
}

describe('capability-quality（B2 质量反馈闭环）', () => {
  it('记录调用并聚合成功率/耗时/次数', () => {
    recordCapabilityUsage(db, { capabilityId: 'speech-to-text', outcome: 'success', durationMs: 100 });
    recordCapabilityUsage(db, { capabilityId: 'speech-to-text', outcome: 'success', durationMs: 200 });
    recordCapabilityUsage(db, { capabilityId: 'speech-to-text', outcome: 'success', durationMs: 300 });
    recordCapabilityUsage(db, { capabilityId: 'speech-to-text', outcome: 'fail', durationMs: 400 });

    const q = getCapabilityQuality(db, 'speech-to-text');
    expect(q.totalCalls).toBe(4);
    expect(q.successCount).toBe(3);
    expect(q.failCount).toBe(1);
    expect(q.successRate).toBe(0.75);
    expect(q.avgDurationMs).toBe(250);
  });

  it('无记录时返回 null 成功率（区分"无数据"与"质量差"）', () => {
    const q = getCapabilityQuality(db, 'never-used');
    expect(q.totalCalls).toBe(0);
    expect(q.successRate).toBeNull();
  });

  it('getAllCapabilityQuality 按能力分组聚合', () => {
    recordCapabilityUsage(db, { capabilityId: 'a', outcome: 'success' });
    recordCapabilityUsage(db, { capabilityId: 'b', outcome: 'fail' });
    const map = getAllCapabilityQuality(db);
    expect(map.get('a')?.successRate).toBe(1);
    expect(map.get('b')?.successRate).toBe(0);
  });
});

describe('findCapabilityGaps（B3 跨类型缺口检测）', () => {
  it('声明能力但无任何已启用工具实现 = 缺口；有活跃工具的不报缺口', () => {
    const { c, worker, project } = fixture();
    insertActiveTool('whisper-local', 'speech-to-text');
    insertBinding(c.id, 'speech-to-text', ['whisper-local']); // 有活跃工具
    insertBinding(c.id, 'image-gen', []); // 无工具 = 缺口

    const task = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '生成封面' });
    const gaps = findCapabilityGaps(db, task);
    expect(gaps.map((g) => g.capabilityId)).toEqual(['image-gen']);
  });

  it('引用了工具但该工具不存在/未启用 也算缺口', () => {
    const { c, worker, project } = fixture();
    insertBinding(c.id, 'video-gen', ['nonexistent-tool']); // 工具不在 registry
    const task = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '生成视频' });
    const gaps = findCapabilityGaps(db, task);
    expect(gaps.map((g) => g.capabilityId)).toEqual(['video-gen']);
  });
});

describe('performCapabilityPrecheck（B2 任务级预检门）', () => {
  it('检测缺口、落 capability_precheck 事件、返回缺口清单', () => {
    const { c, worker, project } = fixture();
    insertActiveTool('whisper-local', 'speech-to-text');
    insertBinding(c.id, 'speech-to-text', ['whisper-local']); // 有活跃工具，非缺口
    insertBinding(c.id, 'image-gen', []); // 缺口
    const task = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '生成封面' });

    const gaps = performCapabilityPrecheck(db, task);
    expect(gaps.map((g) => g.capabilityId)).toEqual(['image-gen']);
    const evt = listTaskEvents(db, task.id).find((e) => e.kind === 'capability_precheck');
    expect(evt?.payload.gapCount).toBe(1);
  });

  it('无缺口时记录 gapCount=0 事件（仍可观测预检已执行）', () => {
    const { c, worker, project } = fixture();
    insertActiveTool('whisper-local', 'speech-to-text');
    insertBinding(c.id, 'speech-to-text', ['whisper-local']);
    const task = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: '转写音频' });

    const gaps = performCapabilityPrecheck(db, task);
    expect(gaps).toHaveLength(0);
    const evt = listTaskEvents(db, task.id).find((e) => e.kind === 'capability_precheck');
    expect(evt?.payload.gapCount).toBe(0);
  });
});
