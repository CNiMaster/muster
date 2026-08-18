import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getWorkbench, getWorkbenchOrNull } from './workbench';
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

/**
 * 边条件类型（决定工作流推进时走哪条边）。
 * 平台级能力，模板/用户按需配置。
 */
export type EdgeCondition =
  | { type: 'always' }
  | { type: 'auto_review'; pass: boolean }
  | { type: 'outcome_equals'; value: string }
  | { type: 'manual_approval' }
  | { type: 'agent_label' };

export interface WorkflowEdge {
  id: string;
  companyId: string;
  workflowId: string;
  sourceId: string;
  targetId: string;
  label: string;
  /** 条件表达式：决定推进时是否走此边。空 = agent_label（向后兼容）。 */
  condition: EdgeCondition;
  /** 最大遍历次数（受控回环保护），0=不限。 */
  maxTraversals: number;
  createdAt: string;
}

interface WorkflowNodeRow {
  id: string;
  workflow_id: string;
  kind: string;
  label: string;
  position_json: string;
  props_json: string;
  created_at: string;
}

interface WorkflowEdgeRow {
  id: string;
  workflow_id: string;
  source_id: string;
  target_id: string;
  label: string;
  condition_json: string;
  max_traversals: number;
  created_at: string;
}

function nodeFromRow(db: DB, r: WorkflowNodeRow): WorkflowNode {
  return {
    id: r.id,
    companyId: getWorkbenchOrNull(db)?.id ?? '',
    workflowId: r.workflow_id,
    kind: r.kind as any,
    label: r.label,
    position: JSON.parse(r.position_json ?? '{}'),
    props: JSON.parse(r.props_json ?? '{}'),
    createdAt: r.created_at,
  };
}

function parseEdgeCondition(json: string, label: string): EdgeCondition {
  if (!json || json === '{}') {
    return { type: 'agent_label' };
  }
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed as EdgeCondition;
    }
  } catch {
    // fall through to default
  }
  void label;
  return { type: 'agent_label' };
}

function edgeFromRow(db: DB, r: WorkflowEdgeRow): WorkflowEdge {
  return {
    id: r.id,
    companyId: getWorkbenchOrNull(db)?.id ?? '',
    workflowId: r.workflow_id,
    sourceId: r.source_id,
    targetId: r.target_id,
    label: r.label,
    condition: parseEdgeCondition(r.condition_json ?? '{}', r.label),
    maxTraversals: r.max_traversals ?? 0,
    createdAt: r.created_at,
  };
}

export function getWorkflow(
  db: DB,
  companyId: string,
  workflowId: string,
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodeRows = db
    .prepare('SELECT * FROM workflow_node WHERE workflow_id = ?')
    .all(workflowId) as WorkflowNodeRow[];
  const edgeRows = db
    .prepare('SELECT * FROM workflow_edge WHERE workflow_id = ?')
    .all(workflowId) as WorkflowEdgeRow[];

  return {
    nodes: nodeRows.map((r) => nodeFromRow(db, r)),
    edges: edgeRows.map((r) => edgeFromRow(db, r)),
  };
}

export function saveWorkflow(
  db: DB,
  companyId: string,
  workflowId: string,
  input: {
    nodes: Array<{ id?: string; kind: 'step' | 'decision' | 'start' | 'end'; label: string; position: { x: number; y: number }; props?: Record<string, unknown> }>;
    edges: Array<{ sourceId: string; targetId: string; label?: string; condition?: EdgeCondition; maxTraversals?: number }>;
  },
): void {
  if (getWorkbench(db).state !== 'off') {
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
    db.prepare('DELETE FROM workflow_node WHERE workflow_id = ?').run(workflowId);
    db.prepare('DELETE FROM workflow_edge WHERE workflow_id = ?').run(workflowId);

    // 2. 写入 node
    const nodeMap = new Map<string, string>(); // 原 id/新 id 映射，如果是 React Flow 自动生成的字符串 ID 则保留它
    for (const n of normalizedNodes) {
      const dbId = n.id || shortId('wn_');
      nodeMap.set(n.id || dbId, dbId);
      db.prepare(
        `INSERT INTO workflow_node (id, workflow_id, kind, label, position_json, props_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        dbId,
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
        `INSERT INTO workflow_edge (id, workflow_id, source_id, target_id, label, condition_json, max_traversals, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        edgeId,
        workflowId,
        sourceDbId,
        targetDbId,
        e.label ?? '',
        JSON.stringify(e.condition ?? { type: 'agent_label' }),
        e.maxTraversals ?? 0,
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
    getAgent(db, assigneeAgentId);
  }
  if (assigneeRole && !listAgents(db).some((agent) => agent.role === assigneeRole)) {
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
    /** 工作流已遍历边计数（回环保护用，从父 Task 继承）。 */
    workflowVisitedEdges?: Record<string, number>;
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
  const agents = listAgents(db);
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
      ...(input.workflowVisitedEdges ? { workflowVisitedEdges: input.workflowVisitedEdges } : {}),
    },
    contextRefs: props.contextRefs,
    outputProtocol: props.outputProtocol,
    priority: props.priority,
  });
}

/**
 * 已完成工作流 Task 的明确后继物化。
 *
 * 条件边求值逻辑（Phase 4 增强）：
 * - always：无条件走此边（优先级最高）
 * - auto_review：解析 Agent 输出中的 REVIEW_STATUS: PASS/FAIL，匹配 pass 布尔
 * - outcome_equals：匹配 Task outcome 字符串
 * - manual_approval：暂停工作流，等待用户确认（暂作为普通分支处理）
 * - agent_label（默认/向后兼容）：Agent 在 workflowNextEdgeLabel 中返回 label
 *
 * 受控回环保护：
 * - 如果边有 maxTraversals > 0，追踪该边被遍历的次数
 * - 超限时拒绝走该边（改走 fallback 边或终止）
 * - 计数通过 Task 的 inputProtocol.workflowVisitedEdges 继承传递
 */
export function advanceWorkflowTask(db: DB, task: Task, result: AgentRunResult): Task[] {
  if (result.outcome !== 'completed') return [];
  const workflowId = task.inputProtocol.workflowId;
  const workflowNodeId = task.inputProtocol.workflowNodeId;
  if (typeof workflowId !== 'string' || typeof workflowNodeId !== 'string') return [];
  const proj = getProject(db, task.projectId);
  const workflow = getWorkflow(db, proj.companyId, workflowId);
  const outgoing = workflow.edges.filter((edge) => edge.sourceId === workflowNodeId);
  if (outgoing.length === 0) return [];

  // 从 inputProtocol 继承的已遍历边计数（回环保护用）
  const visitedEdges = (task.inputProtocol.workflowVisitedEdges ?? {}) as Record<string, number>;

  // 按条件类型求值，选出匹配的边
  const matched = selectEdgeByCondition(outgoing, result, visitedEdges);

  if (matched.length === 0) {
    // 没有条件匹配，回退到 agent_label 模式
    return selectByAgentLabel(db, task, workflow, outgoing, result, workflowId, visitedEdges);
  }

  const selected = matched[0]!;
  const target = workflow.nodes.find((node) => node.id === selected.targetId);
  if (!target) throw new AppError(ErrorCode.VALIDATION, `工作流后继节点 ${selected.targetId} 不存在`);
  if (target.kind === 'end') return [];

  // 回环计数更新
  const newVisited = { ...visitedEdges };
  if (selected.maxTraversals > 0) {
    newVisited[selected.id] = (newVisited[selected.id] ?? 0) + 1;
  }

  return [materializeWorkflowTask(db, {
    projectId: task.projectId,
    workflowId,
    workflowNodeId: target.id,
    parentTaskId: task.id,
    dispatcherAgentId: task.assigneeAgentId ?? undefined,
    workflowVisitedEdges: newVisited,
  })];
}

/** 按条件类型求值选出匹配的边（排除超 maxTraversals 的边）。 */
function selectEdgeByCondition(
  edges: WorkflowEdge[],
  result: AgentRunResult,
  visitedEdges: Record<string, number>,
): WorkflowEdge[] {
  const candidates = edges.filter((e) => {
    // 回环保护：超过 maxTraversals 的边不再可选
    if (e.maxTraversals > 0 && (visitedEdges[e.id] ?? 0) >= e.maxTraversals) {
      return false;
    }
    return true;
  });

  // 优先级：always > auto_review > outcome_equals > manual_approval > agent_label
  // 1. always 边
  const alwaysEdges = candidates.filter((e) => e.condition.type === 'always');
  if (alwaysEdges.length > 0) return alwaysEdges;

  // 2. auto_review 边：解析 REVIEW_STATUS
  const reviewStatus = extractReviewStatus(result.summary);
  if (reviewStatus) {
    const reviewMatch = candidates.filter(
      (e) => e.condition.type === 'auto_review' && e.condition.pass === (reviewStatus === 'PASS'),
    );
    if (reviewMatch.length > 0) return reviewMatch;
  }

  // 3. outcome_equals 边
  const outcomeMatch = candidates.filter(
    (e) => e.condition.type === 'outcome_equals' && e.condition.value === result.outcome,
  );
  if (outcomeMatch.length > 0) return outcomeMatch;

  // 4. manual_approval：总是可选（会创建等待确认的 Task），但优先级低于自动条件
  //    仅当不存在 auto_review/outcome_equals 类型的候选边时才走此分支
  const approvalMatch = candidates.filter((e) => e.condition.type === 'manual_approval');
  if (
    approvalMatch.length > 0 &&
    !candidates.some((e) => e.condition.type === 'auto_review' || e.condition.type === 'outcome_equals')
  ) {
    return approvalMatch;
  }

  return [];
}

/** 向后兼容的 agent_label 匹配（原有多分支逻辑）。 */
function selectByAgentLabel(
  db: DB,
  task: Task,
  workflow: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  outgoing: WorkflowEdge[],
  result: AgentRunResult,
  workflowId: string,
  visitedEdges: Record<string, number>,
): Task[] {
  let selected: WorkflowEdge;
  // 过滤掉超 maxTraversals 的边
  const available = outgoing.filter(
    (e) => e.maxTraversals === 0 || (visitedEdges[e.id] ?? 0) < e.maxTraversals,
  );
  if (available.length === 0) {
    // 所有边都超限了
    throw new AppError(ErrorCode.VALIDATION, `工作流节点所有后继边已达到最大遍历次数，请检查是否存在死循环`);
  }
  if (available.length === 1) {
    selected = available[0]!;
  } else {
    if (!result.workflowNextEdgeLabel) {
      throw new AppError(ErrorCode.VALIDATION, `工作流节点存在 ${available.length} 个后继，必须明确 workflowNextEdgeLabel`);
    }
    const matches = available.filter((edge) => edge.label === result.workflowNextEdgeLabel);
    if (matches.length !== 1) {
      throw new AppError(ErrorCode.VALIDATION, `工作流连线标签无唯一匹配：${result.workflowNextEdgeLabel}`);
    }
    selected = matches[0]!;
  }
  const target = workflow.nodes.find((node) => node.id === selected.targetId);
  if (!target) throw new AppError(ErrorCode.VALIDATION, `工作流后继节点 ${selected.targetId} 不存在`);
  if (target.kind === 'end') return [];

  // 回环计数更新
  const newVisited = { ...visitedEdges };
  if (selected.maxTraversals > 0) {
    newVisited[selected.id] = (newVisited[selected.id] ?? 0) + 1;
  }

  return [materializeWorkflowTask(db, {
    projectId: task.projectId,
    workflowId,
    workflowNodeId: target.id,
    parentTaskId: task.id,
    dispatcherAgentId: task.assigneeAgentId ?? undefined,
    workflowVisitedEdges: newVisited,
  })];
}

/** 从 Agent 输出中解析 REVIEW_STATUS 标记（借鉴 FreeBuddy）。 */
function extractReviewStatus(summary: string | undefined): 'PASS' | 'FAIL' | null {
  if (!summary) return null;
  if (/<<<REVIEW_FAIL>>>/i.test(summary)) return 'FAIL';
  if (/<<<REVIEW_PASS>>>/i.test(summary)) return 'PASS';
  const matches = [...summary.matchAll(/REVIEW[\s_-]*STATUS\s*:\s*(PASS|FAIL)/gi)];
  const last = matches.at(-1)?.[1];
  if (!last) return null;
  return last.toUpperCase() as 'PASS' | 'FAIL';
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
  const agents = listAgents(db);
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
