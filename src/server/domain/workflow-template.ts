/**
 * 可复用工作流模板库（spec 2026-08-12-task-investigation-capability-provisioning B3）。
 *
 * 现状：workflow 是每公司手画的，没有模板注册表/导入导出——不像 skill/tool/persona 都有 template 注册表。
 * 本模块提供与公司无关的工作流模板：保存/列表/查询/实例化到任意公司，补齐该缺口。
 *
 * 存储用「位置索引」表达边（sourceIdx/targetIdx 指向 nodes 数组下标），实例化时生成新 node id 并按索引
 * 重映射，避免全局 PK 冲突与跨公司 id 串用。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';
import { isOrgLocked } from './company';

export interface TemplateNode {
  kind: 'step' | 'decision' | 'start' | 'end';
  label: string;
  position: { x: number; y: number };
  props?: Record<string, unknown>;
}

export interface TemplateEdge {
  /** 起点 nodes 数组下标。 */
  sourceIdx: number;
  /** 终点 nodes 数组下标。 */
  targetIdx: number;
  label?: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  category: string;
  nodes_json: string;
  edges_json: string;
  created_at: string;
  updated_at: string;
}

function fromRow(r: TemplateRow): WorkflowTemplate {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category,
    nodes: JSON.parse(r.nodes_json ?? '[]') as TemplateNode[],
    edges: JSON.parse(r.edges_json ?? '[]') as TemplateEdge[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface SaveWorkflowTemplateInput {
  id?: string;
  name: string;
  description?: string;
  category?: string;
  nodes: TemplateNode[];
  edges: TemplateEdge[];
}

/** 保存（新建或覆盖同名 id）一个工作流模板。 */
export function saveWorkflowTemplate(db: DB, input: SaveWorkflowTemplateInput): WorkflowTemplate {
  if (!input.name.trim()) throw new AppError(ErrorCode.VALIDATION, '模板名称不能为空');
  // 校验边索引合法
  for (const e of input.edges) {
    if (e.sourceIdx < 0 || e.sourceIdx >= input.nodes.length || e.targetIdx < 0 || e.targetIdx >= input.nodes.length) {
      throw new AppError(ErrorCode.VALIDATION, `模板边索引越界：${e.sourceIdx}→${e.targetIdx}（节点数 ${input.nodes.length}）`);
    }
  }
  const id = input.id ?? shortId('wt_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO workflow_template (id, name, description, category, nodes_json, edges_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, category=excluded.category,
       nodes_json=excluded.nodes_json, edges_json=excluded.edges_json, updated_at=excluded.updated_at`,
  ).run(
    id,
    input.name,
    input.description ?? '',
    input.category ?? '',
    JSON.stringify(input.nodes),
    JSON.stringify(input.edges),
    now,
    now,
  );
  return getWorkflowTemplate(db, id)!;
}

export function getWorkflowTemplate(db: DB, id: string): WorkflowTemplate | null {
  const row = db.prepare('SELECT * FROM workflow_template WHERE id = ?').get(id) as TemplateRow | undefined;
  return row ? fromRow(row) : null;
}

export function listWorkflowTemplates(db: DB, category?: string): WorkflowTemplate[] {
  const rows = category
    ? (db.prepare('SELECT * FROM workflow_template WHERE category = ? ORDER BY name').all(category) as TemplateRow[])
    : (db.prepare('SELECT * FROM workflow_template ORDER BY name').all() as TemplateRow[]);
  return rows.map(fromRow);
}

/**
 * 把模板实例化到某公司的一个 workflow_id：生成新 node id，按位置索引重连边，写入 workflow_node/edge。
 * 与 saveWorkflow 一致，要求公司处于下班态（结构变更需 company off）。
 */
export function instantiateWorkflowFromTemplate(db: DB, companyId: string, templateId: string, workflowId: string): { nodeCount: number; edgeCount: number } {
  if (isOrgLocked(db, companyId)) {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '上班期间不能实例化工作流模板');
  }
  const tpl = getWorkflowTemplate(db, templateId);
  if (!tpl) throw new AppError(ErrorCode.NOT_FOUND, `工作流模板 ${templateId} 不存在`);

  const now = nowIso();
  db.transaction(() => {
    // 清空目标 workflow 既有内容（实例化即覆盖）
    db.prepare('DELETE FROM workflow_edge WHERE company_id = ? AND workflow_id = ?').run(companyId, workflowId);
    db.prepare('DELETE FROM workflow_node WHERE company_id = ? AND workflow_id = ?').run(companyId, workflowId);

    const nodeIds = tpl.nodes.map((n) => shortId('wn_'));
    tpl.nodes.forEach((n, i) => {
      db.prepare(
        `INSERT INTO workflow_node (id, company_id, workflow_id, kind, label, position_json, props_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(nodeIds[i], companyId, workflowId, n.kind, n.label, JSON.stringify(n.position ?? { x: 0, y: 0 }), JSON.stringify(n.props ?? {}), now);
    });
    tpl.edges.forEach((e) => {
      db.prepare(
        `INSERT INTO workflow_edge (id, company_id, workflow_id, source_id, target_id, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(shortId('we_'), companyId, workflowId, nodeIds[e.sourceIdx], nodeIds[e.targetIdx], e.label ?? '', now);
    });
  })();

  return { nodeCount: tpl.nodes.length, edgeCount: tpl.edges.length };
}
