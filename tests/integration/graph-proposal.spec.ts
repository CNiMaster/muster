import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * B3.1 自然语言图变更提案测试。
 * 用 FakeSetupGenerator 避免 Claude 依赖，验证 propose/apply 全链路。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { listRelationships } from '../../src/server/domain/graph';
import {
  proposeGraphChange,
  applyGraphProposal,
  type GraphChangeProposal,
} from '../../src/server/domain/graph-proposal';
import type { SetupGenerator } from '../../src/server/domain/setup-assistant';
import { createTask, claimNextTask, markRunning } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { createProject } from '../../src/server/domain/project';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

function makeFakeGenerator(output: unknown): SetupGenerator {
  return {
    async generate(): Promise<unknown> {
      return output;
    },
  };
}

describe('B3.1 自然语言图变更提案', () => {
  it('propose 解析 add_edge 并产出 diff', async () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: '李四', role: 'lead' });
    const writer = createAgent(db, { companyId: c.id, name: '王五', role: 'writer' });
    const proposal: GraphChangeProposal = {
      changes: [{ action: 'add_edge', sourceId: lead.id, targetId: writer.id }],
    };
    const r = await proposeGraphChange(
      db,
      { companyId: c.id, kind: 'org', naturalLanguage: '李四 王五' },
      makeFakeGenerator(proposal),
    );
    expect(r.diff.added.length).toBe(1);
    expect(r.diff.added[0]!.sourceId).toBe(lead.id);
  });

  it('apply 幂等：已存在的边不重复创建', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_2', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const proposal: GraphChangeProposal = {
      changes: [{ action: 'add_edge', sourceId: lead.id, targetId: writer.id }],
    };
    const diff1 = applyGraphProposal(db, { companyId: c.id, kind: 'org', naturalLanguage: '' }, proposal);
    expect(diff1.added.length).toBe(1);
    // 再次应用
    const diff2 = applyGraphProposal(db, { companyId: c.id, kind: 'org', naturalLanguage: '' }, proposal);
    expect(diff2.added.length).toBe(0);
    // 实际只有一条边
    const edges = listRelationships(db, 'org');
    expect(edges.length).toBe(1);
  });

  it('apply remove_edge 走归档（软删除）', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_3', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    // 先加
    applyGraphChange(db, c.id, 'org', lead.id, writer.id, 'add_edge');
    // 再删
    const proposal: GraphChangeProposal = {
      changes: [{ action: 'remove_edge', sourceId: lead.id, targetId: writer.id }],
    };
    const diff = applyGraphProposal(db, { companyId: c.id, kind: 'org', naturalLanguage: '' }, proposal);
    expect(diff.removed.length).toBe(1);
    // 默认 listRelationships 不返回归档
    expect(listRelationships(db, 'org').length).toBe(0);
    // includeArchived 时仍可看到
    expect(listRelationships(db, 'org', { includeArchived: true }).length).toBe(1);
  });

  it('任务执行中 propose 被拒绝（2026-08-23 上下班退役→执行期锁）', async () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_4', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const runner = createAgent(db, { companyId: c.id, name: 'runner', role: 'writer' });
    const project = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/gp-lock' });
    const thread = ensurePrimaryThread(db, project.id, runner.id);
    const task = createTask(db, { projectId: project.id, assigneeAgentId: runner.id, title: '执行中' });
    claimNextTask(db, thread.id, runner.id);
    markRunning(db, task.id);
    await expect(
      proposeGraphChange(
        db,
        { companyId: c.id, kind: 'org', naturalLanguage: 'x' },
        makeFakeGenerator({ changes: [] }),
      ),
    ).rejects.toThrow(/执行中|locked/i);
  });

  it('sourceId 缺失时用 sourceHint 模糊匹配', async () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_5', name: 'co' });
    createAgent(db, { companyId: c.id, name: '张三', role: 'lead' });
    createAgent(db, { companyId: c.id, name: '李四', role: 'writer' });
    const proposal: GraphChangeProposal = {
      changes: [{ action: 'add_edge', sourceHint: 'lead', targetHint: 'writer' }],
    };
    const r = await proposeGraphChange(
      db,
      { companyId: c.id, kind: 'org', naturalLanguage: 'x' },
      makeFakeGenerator(proposal),
    );
    expect(r.proposal.changes[0]!.sourceId).toBeTruthy();
    expect(r.proposal.changes[0]!.targetId).toBeTruthy();
    expect(r.diff.added.length).toBe(1);
  });
});

// helper
function applyGraphChange(
  db: DB,
  companyId: string,
  kind: 'org' | 'communication',
  sourceId: string,
  targetId: string,
  action: 'add_edge' | 'remove_edge',
): void {
  applyGraphProposal(
    db,
    { companyId, kind, naturalLanguage: '' },
    { changes: [{ action, sourceId, targetId }] },
  );
}
