import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { isOrgLocked } from './company';

export interface WorkflowNode {
  id: string;
  companyId: string;
  workflowId: string;
  kind: 'step' | 'decision' | 'start' | 'end';
  label: string;
  position: { x: number; y: number };
  props: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowEdge {
  id: string;
  companyId: string;
  workflowId: string;
  sourceId: string;
  targetId: string;
  label: string;
  createdAt: string;
}

interface WorkflowNodeRow {
  id: string;
  company_id: string;
  workflow_id: string;
  kind: string;
  label: string;
  position_json: string;
  props_json: string;
  created_at: string;
}

interface WorkflowEdgeRow {
  id: string;
  company_id: string;
  workflow_id: string;
  source_id: string;
  target_id: string;
  label: string;
  created_at: string;
}

function nodeFromRow(r: WorkflowNodeRow): WorkflowNode {
  return {
    id: r.id,
    companyId: r.company_id,
    workflowId: r.workflow_id,
    kind: r.kind as any,
    label: r.label,
    position: JSON.parse(r.position_json ?? '{}'),
    props: JSON.parse(r.props_json ?? '{}'),
    createdAt: r.created_at,
  };
}

function edgeFromRow(r: WorkflowEdgeRow): WorkflowEdge {
  return {
    id: r.id,
    companyId: r.company_id,
    workflowId: r.workflow_id,
    sourceId: r.source_id,
    targetId: r.target_id,
    label: r.label,
    createdAt: r.created_at,
  };
}

export function getWorkflow(
  db: DB,
  companyId: string,
  workflowId: string,
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodeRows = db
    .prepare('SELECT * FROM workflow_node WHERE company_id = ? AND workflow_id = ?')
    .all(companyId, workflowId) as WorkflowNodeRow[];
  const edgeRows = db
    .prepare('SELECT * FROM workflow_edge WHERE company_id = ? AND workflow_id = ?')
    .all(companyId, workflowId) as WorkflowEdgeRow[];

  return {
    nodes: nodeRows.map(nodeFromRow),
    edges: edgeRows.map(edgeFromRow),
  };
}

export function saveWorkflow(
  db: DB,
  companyId: string,
  workflowId: string,
  input: {
    nodes: Array<{ id?: string; kind: 'step' | 'decision' | 'start' | 'end'; label: string; position: { x: number; y: number }; props?: Record<string, unknown> }>;
    edges: Array<{ sourceId: string; targetId: string; label?: string }>;
  },
): void {
  if (isOrgLocked(db, companyId)) {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '上班期间不能修改工作流图');
  }

  const now = nowIso();

  // 用 better-sqlite3 事务包裹删除与重新写入
  db.transaction(() => {
    // 1. 删除现有
    db.prepare('DELETE FROM workflow_node WHERE company_id = ? AND workflow_id = ?').run(companyId, workflowId);
    db.prepare('DELETE FROM workflow_edge WHERE company_id = ? AND workflow_id = ?').run(companyId, workflowId);

    // 2. 写入 node
    const nodeMap = new Map<string, string>(); // 原 id/新 id 映射，如果是 React Flow 自动生成的字符串 ID 则保留它
    for (const n of input.nodes) {
      const dbId = n.id || shortId('wn_');
      nodeMap.set(n.id || dbId, dbId);
      db.prepare(
        `INSERT INTO workflow_node (id, company_id, workflow_id, kind, label, position_json, props_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        dbId,
        companyId,
        workflowId,
        n.kind,
        n.label,
        JSON.stringify(n.position),
        JSON.stringify(n.props ?? {}),
        now
      );
    }

    // 3. 写入 edge
    for (const e of input.edges) {
      const sourceDbId = nodeMap.get(e.sourceId);
      const targetDbId = nodeMap.get(e.targetId);
      if (!sourceDbId || !targetDbId) {
        throw new AppError(ErrorCode.VALIDATION, `连线节点不存在: source ${e.sourceId} -> target ${e.targetId}`);
      }
      const edgeId = shortId('we_');
      db.prepare(
        `INSERT INTO workflow_edge (id, company_id, workflow_id, source_id, target_id, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        edgeId,
        companyId,
        workflowId,
        sourceDbId,
        targetDbId,
        e.label ?? '',
        now
      );
    }
  })();
}

/**
 * 校验工作流图：
 * - 必须有且仅有一个 start 节点
 * - 必须有至少一个 end 节点
 * - 所有节点必须能从 start 节点到达（不可达节点检测）
 * - 所有节点必须能到达至少一个 end 节点（断裂流程/死路检测）
 * - 孤立节点检测
 */
export function validateWorkflow(
  db: DB,
  companyId: string,
  workflowId: string,
): string[] {
  const { nodes, edges } = getWorkflow(db, companyId, workflowId);
  const errors: string[] = [];

  if (nodes.length === 0) return [];

  // 1. start / end 节点数量校验
  const starts = nodes.filter((n) => n.kind === 'start');
  const ends = nodes.filter((n) => n.kind === 'end');

  if (starts.length === 0) {
    errors.push('缺少开始节点 (start)');
  } else if (starts.length > 1) {
    errors.push(`只能有一个开始节点，当前有 ${starts.length} 个`);
  }

  if (ends.length === 0) {
    errors.push('缺少结束节点 (end)');
  }

  if (errors.length > 0) {
    // 缺少起点/终点时无法进行通路连通性校验，直接返回
    return errors;
  }

  const startNode = starts[0]!;
  const nodeIds = nodes.map((n) => n.id);
  const totalNodes = nodes.length;

  // 构建邻接表
  const adj = new Map<string, string[]>();
  const revAdj = new Map<string, string[]>();
  for (const nid of nodeIds) {
    adj.set(nid, []);
    revAdj.set(nid, []);
  }

  for (const e of edges) {
    adj.get(e.sourceId)?.push(e.targetId);
    revAdj.get(e.targetId)?.push(e.sourceId);
  }

  // 2. 孤立节点检测
  for (const n of nodes) {
    const inDegree = revAdj.get(n.id)?.length ?? 0;
    const outDegree = adj.get(n.id)?.length ?? 0;
    if (inDegree === 0 && outDegree === 0) {
      errors.push(`节点「${n.label}」是孤立节点，未连接任何流程`);
    }
  }

  // 3. 开始节点可达性 BFS
  const visitedFromStart = new Set<string>();
  const queue1: string[] = [startNode.id];
  visitedFromStart.add(startNode.id);

  while (queue1.length > 0) {
    const curr = queue1.shift()!;
    const neighbors = adj.get(curr) ?? [];
    for (const neighbor of neighbors) {
      if (!visitedFromStart.has(neighbor)) {
        visitedFromStart.add(neighbor);
        queue1.push(neighbor);
      }
    }
  }

  // 找出从 start 无法到达的节点
  for (const n of nodes) {
    if (!visitedFromStart.has(n.id)) {
      errors.push(`不可达节点：无法从起点到达节点「${n.label}」`);
    }
  }

  // 4. 到达终点可达性 BFS (在反向图上从所有 end 节点开始)
  const visitedToEnd = new Set<string>();
  const queue2: string[] = ends.map((e) => e.id);
  ends.forEach((e) => visitedToEnd.add(e.id));

  while (queue2.length > 0) {
    const curr = queue2.shift()!;
    const parents = revAdj.get(curr) ?? [];
    for (const parent of parents) {
      if (!visitedToEnd.has(parent)) {
        visitedToEnd.add(parent);
        queue2.push(parent);
      }
    }
  }

  // 找出无法到达任何 end 节点的节点 (即流程断裂/死路)
  for (const n of nodes) {
    if (!visitedToEnd.has(n.id)) {
      errors.push(`流程断裂：从节点「${n.label}」出发无法到达任何结束节点`);
    }
  }

  return errors;
}
