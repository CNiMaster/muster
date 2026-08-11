/**
 * 可复用工作流模板库 集成测试（spec 2026-08-12 B3）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import { setDbForTest, type DB } from '../../src/server/db/client';
import { createCompany, transitionCompany } from '../../src/server/domain/company';
import { saveWorkflowTemplate, getWorkflowTemplate, listWorkflowTemplates, instantiateWorkflowFromTemplate } from '../../src/server/domain/workflow-template';
import { getWorkflow } from '../../src/server/domain/workflow';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
  setDbForTest(db);
});

const NODES = [
  { kind: 'start' as const, label: '开始', position: { x: 0, y: 0 } },
  { kind: 'step' as const, label: '开发', position: { x: 1, y: 0 } },
  { kind: 'end' as const, label: '完成', position: { x: 2, y: 0 } },
];
const EDGES = [
  { sourceIdx: 0, targetIdx: 1 },
  { sourceIdx: 1, targetIdx: 2 },
];

describe('workflow-template（B3 可复用工作流模板）', () => {
  it('保存并读取模板（节点+边）', () => {
    const t = saveWorkflowTemplate(db, { name: '标准开发流', description: '开始→开发→完成', category: 'software', nodes: NODES, edges: EDGES });
    expect(t.id).toBeTruthy();
    const got = getWorkflowTemplate(db, t.id)!;
    expect(got.name).toBe('标准开发流');
    expect(got.nodes).toHaveLength(3);
    expect(got.edges).toHaveLength(2);
  });

  it('listWorkflowTemplates 支持按 category 过滤', () => {
    saveWorkflowTemplate(db, { name: 'A', category: 'software', nodes: NODES, edges: EDGES });
    saveWorkflowTemplate(db, { name: 'B', category: 'content', nodes: NODES, edges: EDGES });
    expect(listWorkflowTemplates(db, 'software')).toHaveLength(1);
    expect(listWorkflowTemplates(db)).toHaveLength(2);
  });

  it('边索引越界拒绝保存', () => {
    expect(() => saveWorkflowTemplate(db, { name: 'bad', nodes: NODES, edges: [{ sourceIdx: 0, targetIdx: 99 }] })).toThrow();
  });

  it('实例化到公司 workflow：节点/边出现，且不与模板 id 冲突（可多次实例化）', () => {
    const c = createCompany(db, { name: 'co' });
    transitionCompany(db, c.id, 'off'); // 实例化需下班态
    const t = saveWorkflowTemplate(db, { name: 'T', nodes: NODES, edges: EDGES });

    const r1 = instantiateWorkflowFromTemplate(db, c.id, t.id, 'wf-1');
    expect(r1.nodeCount).toBe(3);
    const w1 = getWorkflow(db, c.id, 'wf-1');
    expect(w1.nodes).toHaveLength(3);
    expect(w1.edges).toHaveLength(2);
    expect(w1.nodes.map((n) => n.label)).toEqual(['开始', '开发', '完成']);

    // 第二次实例化到另一 workflow 不应因 id 冲突失败
    const r2 = instantiateWorkflowFromTemplate(db, c.id, t.id, 'wf-2');
    expect(r2.nodeCount).toBe(3);
    expect(getWorkflow(db, c.id, 'wf-2').nodes).toHaveLength(3);
  });

  it('实例化覆盖目标 workflow 既有内容', () => {
    const c = createCompany(db, { name: 'co' });
    transitionCompany(db, c.id, 'off');
    const t = saveWorkflowTemplate(db, { name: 'T', nodes: NODES, edges: EDGES });
    instantiateWorkflowFromTemplate(db, c.id, t.id, 'wf');
    // 再次实例化同一 workflow 应替换而非叠加
    instantiateWorkflowFromTemplate(db, c.id, t.id, 'wf');
    const w = getWorkflow(db, c.id, 'wf');
    expect(w.nodes).toHaveLength(3);
    expect(w.edges).toHaveLength(2);
  });
});
