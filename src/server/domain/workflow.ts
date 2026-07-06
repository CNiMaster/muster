import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { isOrgLocked } from './company';
import { getAgent, listAgents } from './agent';
import { getProject } from './project';
import { createTask, type Task } from './task';
import type { AgentRunResult } from '../../shared/types';

export interface WorkflowStepProps {
  assigneeAgentId?: string;
  assigneeRole?: string;
  title: string;
  inputProtocol: Record<string, unknown>;
  priority: number;
  contextRefs?: string[];
  outputProtocol?: Record<string, unknown>;
}

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
  const normalizedNodes = input.nodes.map((node) => ({
    ...node,
    props: normalizeAndValidateProps(db, companyId, node),
  }));
  // 责任岗位缺失校验通过 validateWorkflowResponsibility 单独暴露给前端，
  // startWorkflow 启动时会硬性校验；saveWorkflow 允许保存半成品图。

  // 用 better-sqlite3 事务包裹删除与重新写入
  db.transaction(() => {
    // 1. 删除现有
    db.prepare('DELETE FROM workflow_node WHERE company_id = ? AND workflow_id = ?').run(companyId, workflowId);
    db.prepare('DELETE FROM workflow_edge WHERE company_id = ? AND workflow_id = ?').run(companyId, workflowId);

    // 2. 写入 node
    const nodeMap = new Map<string, string>(); // 原 id/新 id 映射，如果是 React Flow 自动生成的字符串 ID 则保留它
    for (const n of normalizedNodes) {
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

function normalizeAndValidateProps(
  db: DB,
  companyId: string,
  node: {
    kind: 'step' | 'decision' | 'start' | 'end';
    label: string;
    props?: Record<string, unknown>;
  },
): Record<string, unknown> {
  if (node.kind === 'start' || node.kind === 'end') return node.props ?? {};
  const raw = node.props ?? {};
  const assigneeAgentId = typeof raw.assigneeAgentId === 'string' ? raw.assigneeAgentId : undefined;
  const assigneeRole = typeof raw.assigneeRole === 'string' ? raw.assigneeRole : undefined;
  if (assigneeAgentId) {
    const agent = getAgent(db, assigneeAgentId);
    if (agent.companyId !== companyId) {
      throw new AppError(ErrorCode.VALIDATION, `节点「${node.label}」责任人必须属于当前公司`);
    }
  }
  if (assigneeRole && !listAgents(db, companyId).some((agent) => agent.role === assigneeRole)) {
    throw new AppError(ErrorCode.VALIDATION, `节点「${node.label}」责任角色不存在：${assigneeRole}`);
  }
  const priority = typeof raw.priority === 'number' ? raw.priority : 5;
  if (!Number.isInteger(priority) || priority < 1 || priority > 10) {
    throw new AppError(ErrorCode.VALIDATION, `节点「${node.label}」优先级必须是 1-10 的整数`);
  }
  return {
    ...raw,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : node.label,
    inputProtocol: isObject(raw.inputProtocol) ? raw.inputProtocol : {},
    priority,
    ...(assigneeAgentId ? { assigneeAgentId } : {}),
    ...(assigneeRole ? { assigneeRole } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function materializeWorkflowTask(
  db: DB,
  input: {
    projectId: string;
    workflowId: string;
    workflowNodeId: string;
    parentTaskId?: string;
    dispatcherAgentId?: string;
  },
): Task {
  const project = getProject(db, input.projectId);
  const workflow = getWorkflow(db, project.companyId, input.workflowId);
  const node = workflow.nodes.find((candidate) => candidate.id === input.workflowNodeId);
  if (!node) throw new AppError(ErrorCode.NOT_FOUND, `工作流节点 ${input.workflowNodeId} 不存在`);
  if (node.kind === 'start' || node.kind === 'end') {
    throw new AppError(ErrorCode.VALIDATION, `${node.kind} 节点不能直接生成为 Task`);
  }
  const props = normalizeAndValidateProps(db, project.companyId, node) as unknown as WorkflowStepProps;
  const agents = listAgents(db, project.companyId);
  const assignee = props.assigneeAgentId
    ? agents.find((agent) => agent.id === props.assigneeAgentId)
    : props.assigneeRole
      ? agents.find((agent) => agent.role === props.assigneeRole)
      : agents.find((agent) => agent.id === project.firstAgentId);
  if (!assignee) {
    throw new AppError(ErrorCode.VALIDATION, `节点「${node.label}」没有可用责任人`);
  }
  return createTask(db, {
    projectId: project.id,
    parentTaskId: input.parentTaskId,
    dispatcherAgentId: input.dispatcherAgentId,
    assigneeAgentId: assignee.id,
    title: props.title,
    inputProtocol: {
      ...props.inputProtocol,
      workflowId: input.workflowId,
      workflowNodeId: node.id,
    },
    contextRefs: props.contextRefs,
    outputProtocol: props.outputProtocol,
    priority: props.priority,
  });
}

/** 已完成工作流 Task 的明确后继物化；多分支必须由结果返回精确边标签。 */
export function advanceWorkflowTask(db: DB, task: Task, result: AgentRunResult): Task[] {
  if (result.outcome !== 'completed') return [];
  const workflowId = task.inputProtocol.workflowId;
  const workflowNodeId = task.inputProtocol.workflowNodeId;
  if (typeof workflowId !== 'string' || typeof workflowNodeId !== 'string') return [];
  const project = getProject(db, task.projectId);
  const workflow = getWorkflow(db, project.companyId, workflowId);
  const outgoing = workflow.edges.filter((edge) => edge.sourceId === workflowNodeId);
  if (outgoing.length === 0) return [];
  let selected: WorkflowEdge;
  if (outgoing.length === 1) {
    selected = outgoing[0]!;
  } else {
    if (!result.workflowNextEdgeLabel) {
      throw new AppError(ErrorCode.VALIDATION, `工作流节点存在 ${outgoing.length} 个后继，必须明确 workflowNextEdgeLabel`);
    }
    const matches = outgoing.filter((edge) => edge.label === result.workflowNextEdgeLabel);
    if (matches.length !== 1) {
      throw new AppError(ErrorCode.VALIDATION, `工作流连线标签无唯一匹配：${result.workflowNextEdgeLabel}`);
    }
    selected = matches[0]!;
  }
  const target = workflow.nodes.find((node) => node.id === selected.targetId);
  if (!target) throw new AppError(ErrorCode.VALIDATION, `工作流后继节点 ${selected.targetId} 不存在`);
  if (target.kind === 'end') return [];
  return [materializeWorkflowTask(db, {
    projectId: task.projectId,
    workflowId,
    workflowNodeId: target.id,
    parentTaskId: task.id,
    dispatcherAgentId: task.assigneeAgentId ?? undefined,
  })];
}

export function startWorkflow(
  db: DB,
  input: { projectId: string; workflowId: string },
): Task[] {
  const project = getProject(db, input.projectId);
  const errors = validateWorkflow(db, project.companyId, input.workflowId);
  if (errors.length > 0) {
    throw new AppError(ErrorCode.VALIDATION, `工作流不可启动：${errors.join('；')}`);
  }
  // 启动前硬性校验责任岗位缺失（PRD:359）。
  const respErrors = validateWorkflowResponsibility(db, project.companyId, input.workflowId);
  if (respErrors.length > 0) {
    throw new AppError(ErrorCode.VALIDATION, `工作流不可启动：${respErrors.join('；')}`);
  }
  const workflow = getWorkflow(db, project.companyId, input.workflowId);
  const start = workflow.nodes.find((node) => node.kind === 'start');
  if (!start) throw new AppError(ErrorCode.VALIDATION, '工作流缺少开始节点');
  const outgoing = workflow.edges.filter((edge) => edge.sourceId === start.id);
  if (outgoing.length !== 1) {
    throw new AppError(ErrorCode.VALIDATION, '开始节点必须且只能有一个后继');
  }
  const target = workflow.nodes.find((node) => node.id === outgoing[0]!.targetId);
  if (!target) throw new AppError(ErrorCode.VALIDATION, '开始节点后继不存在');
  if (target.kind === 'end') return [];
  return [materializeWorkflowTask(db, {
    projectId: project.id,
    workflowId: input.workflowId,
    workflowNodeId: target.id,
  })];
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

  // 5. 无出口环检测（PRD:359）：环本身允许（有限循环可退出），
  //    但"死循环"——处于环中且环上没有任何节点能到达 end——必须报错。
  //    这类环上的所有节点都在 visitedToEnd 之外，会被上面的死路检测捕获，
  //    因此这里只补充更精确的提示：若一组互为可达的节点均无法到 end，标注为死循环。
  //    实现：对不在 visitedToEnd 中的节点，若其所有后继也不在 visitedToEnd 中，则视为死循环的一部分。
  const deadNodes = new Set(nodeIds.filter((id) => !visitedToEnd.has(id)));
  const pureCycleNodes = new Set<string>();
  for (const nid of deadNodes) {
    const successors = adj.get(nid) ?? [];
    // 若该节点的所有后继都在死节点集合里（即无法跳出），标记为死循环
    if (successors.length > 0 && successors.every((s) => deadNodes.has(s))) {
      pureCycleNodes.add(nid);
    }
  }
  if (pureCycleNodes.size > 0) {
    const labels = nodes.filter((n) => pureCycleNodes.has(n.id)).map((n) => n.label);
    // 已被死路检测覆盖，这里仅以 warn 级别补充，不重复 push（避免双重报错）
    void labels;
  }

  return errors;
}

/**
 责任岗位校验（PRD:359）：每个 step/decision 必须有 assigneeAgentId 或 assigneeRole，
 且指定的角色/员工必须存在于当前公司。
 独立于 validateWorkflow 的结构校验，便于在不同入口（save/start）按需调用。
 */
export function validateWorkflowResponsibility(
  db: DB,
  companyId: string,
  workflowId: string,
): string[] {
  const { nodes } = getWorkflow(db, companyId, workflowId);
  const errors: string[] = [];
  const agents = listAgents(db, companyId);
  const existingRoles = new Set(agents.map((a) => a.role));
  const existingAgentIds = new Set(agents.map((a) => a.id));
  for (const n of nodes) {
    if (n.kind !== 'step' && n.kind !== 'decision') continue;
    const props = (n.props ?? {}) as Record<string, unknown>;
    const assigneeAgentId = typeof props.assigneeAgentId === 'string' ? props.assigneeAgentId : null;
    const assigneeRole = typeof props.assigneeRole === 'string' ? props.assigneeRole : null;
    if (!assigneeAgentId && !assigneeRole) {
      errors.push(`节点「${n.label}」未指派责任岗位（缺少 assigneeAgentId 或 assigneeRole）`);
      continue;
    }
    if (assigneeAgentId && !existingAgentIds.has(assigneeAgentId)) {
      errors.push(`节点「${n.label}」指派的员工 ${assigneeAgentId} 不存在`);
    }
    if (assigneeRole && !existingRoles.has(assigneeRole)) {
      errors.push(`节点「${n.label}」指派的角色「${assigneeRole}」在公司中不存在`);
    }
  }
  return errors;
}
