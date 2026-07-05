import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany, transitionCompany } from '../../src/server/domain/company';
import { saveWorkflow, getWorkflow, validateWorkflow } from '../../src/server/domain/workflow';
import { AppError, ErrorCode } from '../../src/shared/errors';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('Workflow Graph domain logic', () => {
  it('可以正确保存和加载工作流节点及连线', () => {
    const c = createCompany(db, { name: 'co' });
    const workflowId = 'test-flow';

    const nodes = [
      { id: 'start_1', kind: 'start' as const, label: '开始', position: { x: 100, y: 100 } },
      { id: 'step_1', kind: 'step' as const, label: '编辑章节', position: { x: 200, y: 200 } },
      { id: 'end_1', kind: 'end' as const, label: '结束', position: { x: 300, y: 300 } },
    ];
    const edges = [
      { sourceId: 'start_1', targetId: 'step_1', label: '到步骤1' },
      { sourceId: 'step_1', targetId: 'end_1' },
    ];

    // 保存
    saveWorkflow(db, c.id, workflowId, { nodes, edges });

    // 加载并校验
    const loaded = getWorkflow(db, c.id, workflowId);
    expect(loaded.nodes).toHaveLength(3);
    expect(loaded.edges).toHaveLength(2);

    expect(loaded.nodes.find((n) => n.id === 'start_1')?.label).toBe('开始');
    expect(loaded.nodes.find((n) => n.id === 'start_1')?.kind).toBe('start');
    expect(loaded.edges.find((e) => e.sourceId === 'start_1')?.targetId).toBe('step_1');
    expect(loaded.edges.find((e) => e.sourceId === 'start_1')?.label).toBe('到步骤1');
  });

  it('公司上班时（LOCK）禁止修改工作流图', () => {
    const c = createCompany(db, { name: 'co' });
    transitionCompany(db, c.id, 'online'); // 上班锁组织

    const nodes = [
      { id: 'start_1', kind: 'start' as const, label: '开始', position: { x: 100, y: 100 } },
      { id: 'end_1', kind: 'end' as const, label: '结束', position: { x: 300, y: 300 } },
    ];
    const edges = [{ sourceId: 'start_1', targetId: 'end_1' }];

    expect(() => {
      saveWorkflow(db, c.id, 'main', { nodes, edges });
    }).toThrowError(/上班期间不能修改工作流图/);
  });

  it('校验规则 1：缺失 start/end 节点报错', () => {
    const c = createCompany(db, { name: 'co' });
    const workflowId = 'main';

    // 只有 step 节点
    saveWorkflow(db, c.id, workflowId, {
      nodes: [{ id: 'step_1', kind: 'step' as const, label: '步骤', position: { x: 1, y: 1 } }],
      edges: [],
    });

    const errs = validateWorkflow(db, c.id, workflowId);
    expect(errs).toContain('缺少开始节点 (start)');
    expect(errs).toContain('缺少结束节点 (end)');
  });

  it('校验规则 2：多个 start 节点报错', () => {
    const c = createCompany(db, { name: 'co' });
    const workflowId = 'main';

    saveWorkflow(db, c.id, workflowId, {
      nodes: [
        { id: 'start_1', kind: 'start' as const, label: '开始1', position: { x: 1, y: 1 } },
        { id: 'start_2', kind: 'start' as const, label: '开始2', position: { x: 1, y: 2 } },
        { id: 'end_1', kind: 'end' as const, label: '结束', position: { x: 2, y: 2 } },
      ],
      edges: [
        { sourceId: 'start_1', targetId: 'end_1' },
        { sourceId: 'start_2', targetId: 'end_1' },
      ],
    });

    const errs = validateWorkflow(db, c.id, workflowId);
    expect(errs).toContain('只能有一个开始节点，当前有 2 个');
  });

  it('校验规则 3：孤立节点和不可达节点报错', () => {
    const c = createCompany(db, { name: 'co' });
    const workflowId = 'main';

    saveWorkflow(db, c.id, workflowId, {
      nodes: [
        { id: 'start_1', kind: 'start' as const, label: '开始', position: { x: 1, y: 1 } },
        { id: 'step_1', kind: 'step' as const, label: '步骤1', position: { x: 2, y: 2 } },
        { id: 'step_2', kind: 'step' as const, label: '孤立步骤', position: { x: 3, y: 3 } },
        { id: 'end_1', kind: 'end' as const, label: '结束', position: { x: 4, y: 4 } },
      ],
      edges: [
        { sourceId: 'start_1', targetId: 'step_1' },
        { sourceId: 'step_1', targetId: 'end_1' },
      ],
    });

    const errs = validateWorkflow(db, c.id, workflowId);
    expect(errs).toContain('节点「孤立步骤」是孤立节点，未连接任何流程');
    expect(errs).toContain('不可达节点：无法从起点到达节点「孤立步骤」');
    expect(errs).toContain('流程断裂：从节点「孤立步骤」出发无法到达任何结束节点');
  });

  it('校验规则 4：死路（无法到达结束节点）报错', () => {
    const c = createCompany(db, { name: 'co' });
    const workflowId = 'main';

    // 步骤 2 连向别处或者没有出路，不能到达 end_1
    saveWorkflow(db, c.id, workflowId, {
      nodes: [
        { id: 'start_1', kind: 'start' as const, label: '开始', position: { x: 1, y: 1 } },
        { id: 'step_1', kind: 'step' as const, label: '步骤1', position: { x: 2, y: 2 } },
        { id: 'step_2', kind: 'step' as const, label: '死胡同步骤', position: { x: 3, y: 3 } },
        { id: 'end_1', kind: 'end' as const, label: '结束', position: { x: 4, y: 4 } },
      ],
      edges: [
        { sourceId: 'start_1', targetId: 'step_1' },
        { sourceId: 'step_1', targetId: 'end_1' },
        { sourceId: 'step_1', targetId: 'step_2' }, // 可以从起点到步骤2，但步骤2没有连向 end_1
      ],
    });

    const errs = validateWorkflow(db, c.id, workflowId);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('流程断裂：从节点「死胡同步骤」出发无法到达任何结束节点');
  });

  it('完美的流程图应当校验全绿（通过）', () => {
    const c = createCompany(db, { name: 'co' });
    const workflowId = 'main';

    saveWorkflow(db, c.id, workflowId, {
      nodes: [
        { id: 'start', kind: 'start' as const, label: '开始', position: { x: 1, y: 1 } },
        { id: 'decide', kind: 'decision' as const, label: '是否符合规范', position: { x: 2, y: 2 } },
        { id: 'step_yes', kind: 'step' as const, label: '发布章节', position: { x: 3, y: 1 } },
        { id: 'step_no', kind: 'step' as const, label: '打回重写', position: { x: 3, y: 3 } },
        { id: 'end', kind: 'end' as const, label: '结束', position: { x: 4, y: 2 } },
      ],
      edges: [
        { sourceId: 'start', targetId: 'decide' },
        { sourceId: 'decide', targetId: 'step_yes', label: '是' },
        { sourceId: 'decide', targetId: 'step_no', label: '否' },
        { sourceId: 'step_yes', targetId: 'end' },
        { sourceId: 'step_no', targetId: 'decide' }, // 循环也是允许的，只要能到达结束
      ],
    });

    const errs = validateWorkflow(db, c.id, workflowId);
    expect(errs).toHaveLength(0);
  });
});
