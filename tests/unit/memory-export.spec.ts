/**
 * 选择闭环 S5：记忆导出/迁移单测。
 * 口径守卫（spec 2026-08-27-selection-loop 定案）：
 * - 导出只含 project scope 该项目条目（personal/craft/workspace 绝不混入）
 * - bundle 精确裁剪：个人偏好不随包误送（换机/移交安全边界）
 * - 导入走真实管道（createMemoryCandidate → FTS/版本化），fingerprint 幂等去重
 * - 坏 bundle（kind/version 不符）拒收
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { makeTestDb } from '../integration/setup';
import type { DB } from '../../src/server/db/client';
import { exportProjectMemory, exportMemoryBundle, importMemoryBundle } from '../../src/server/domain/memory-export';
import { createMemoryCandidate } from '../../src/server/domain/memory';
import { createAgentProfile } from '../../src/server/domain/agent-profile';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';

let db: DB;
let projectId: string;
let otherProjectId: string;
let profileId: string;
beforeEach(() => {
  db = makeTestDb().db;
  const workbench = restoreWorkbench(db, { id: 'wb_exp', name: '导出测试' });
  projectId = createProject(db, { companyId: workbench.id, name: '导出项目', initialState: 'active' }).id;
  otherProjectId = createProject(db, { companyId: workbench.id, name: '另一项目', initialState: 'active' }).id;
  profileId = createAgentProfile(db, { displayName: '档案' }).id;
});

function addEntry(scope: 'personal' | 'project' | 'workspace', content: string, opts?: { projectId?: string; fingerprint?: string }): void {
  createMemoryCandidate(db, {
    profileId,
    scope,
    projectId: scope === 'project' ? (opts?.projectId ?? projectId) : undefined,
    content,
    fingerprint: opts?.fingerprint,
    author: 'agent',
    confidence: 1,
    canInfluence: true,
    allowAutoApprove: true,
  });
}

describe('exportProjectMemory（视图导出）', () => {
  it('只含本项目 project scope；personal/他项目不混入', () => {
    addEntry('project', '本项目经验甲');
    addEntry('project', '他项目经验', { projectId: otherProjectId });
    addEntry('personal', '用户私人偏好');

    const md = exportProjectMemory(db, projectId, 'markdown');
    expect(md.count).toBe(1);
    expect(md.content).toContain('本项目经验甲');
    expect(md.content).not.toContain('他项目经验');
    expect(md.content).not.toContain('用户私人偏好');
    expect(md.filename).toMatch(/^muster-memory-导出项目-\d{4}-\d{2}-\d{2}\.md$/);

    const json = exportProjectMemory(db, projectId, 'json');
    const parsed = JSON.parse(json.content) as { entries: Array<{ content: string }> };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].content).toBe('本项目经验甲');
  });
});

describe('exportMemoryBundle / importMemoryBundle（迁移协议）', () => {
  it('bundle 只含项目层；personal 不随包误送', () => {
    addEntry('project', '可迁移经验', { fingerprint: 'fp-mig' });
    addEntry('personal', '绝不能外泄的偏好');
    const { bundle, count } = exportMemoryBundle(db, projectId);
    expect(count).toBe(1);
    expect(bundle.kind).toBe('muster-memory-bundle');
    expect(bundle.entries).toHaveLength(1);
    expect(bundle.entries[0].content).toBe('可迁移经验');
    expect(JSON.stringify(bundle)).not.toContain('绝不能外泄的偏好');
  });

  it('导入到目标项目走真实管道；fingerprint 幂等（重复导入跳过）', () => {
    addEntry('project', '可迁移经验', { fingerprint: 'fp-mig' });
    const { bundle } = exportMemoryBundle(db, projectId);

    const first = importMemoryBundle(db, bundle, otherProjectId);
    expect(first.imported).toBe(1);
    const inTarget = db.prepare(`SELECT COUNT(*) n FROM memory_entry WHERE project_id=? AND content='可迁移经验'`).get(otherProjectId) as { n: number };
    expect(inTarget.n).toBe(1);
    // 走了管道：FTS 已建索引
    const fts = db.prepare(`SELECT COUNT(*) n FROM memory_fts WHERE entry_id IN (SELECT id FROM memory_entry WHERE project_id=?)`).get(otherProjectId) as { n: number };
    expect(fts.n).toBeGreaterThan(0);

    const second = importMemoryBundle(db, bundle, otherProjectId);
    expect(second.imported).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
  });

  it('坏 bundle 拒收（kind/version 不符）', () => {
    expect(() => importMemoryBundle(db, { kind: 'other' }, otherProjectId)).toThrow();
    expect(() => importMemoryBundle(db, { kind: 'muster-memory-bundle', version: 2, source: { projectName: 'x' }, entries: [] }, otherProjectId)).toThrow();
  });
});
