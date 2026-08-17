/**
 * 画布视觉排布 Sidecar 持久化与防环 DAG 治理。
 * 参考: ahamoment-101/Open-DeepSeek-Harness-Desktop
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';

export interface CanvasNodeLayout {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data?: Record<string, unknown>;
}

export interface CanvasEdgeLayout {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  data?: Record<string, unknown>;
}

export interface CanvasLayoutData {
  nodes: CanvasNodeLayout[];
  edges: CanvasEdgeLayout[];
  viewport?: { x: number; y: number; zoom: number };
}

export interface CanvasLayout {
  id: string;
  canvasKey: string;
  layout: CanvasLayoutData;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface CanvasLayoutRow {
  id: string;
  canvas_key: string;
  layout_json: string;
  version: number;
  created_at: string;
  updated_at: string;
}

function fromRow(row: CanvasLayoutRow): CanvasLayout {
  return {
    id: row.id,
    canvasKey: row.canvas_key,
    layout: JSON.parse(row.layout_json || '{"nodes":[],"edges":[]}'),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 环路检测：验证有向边集合是否包含环 (DAG Validation)。
 * 返回 true 表示存在环（非法），false 表示合法无环 DAG。
 */
export function hasCycleInEdges(edges: Array<{ source: string; target: string }>): boolean {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.source === edge.target) return true; // 自环
    const list = adj.get(edge.source) || [];
    list.push(edge.target);
    adj.set(edge.source, list);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string): boolean {
    visited.add(node);
    inStack.add(node);

    const neighbors = adj.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true;
      } else if (inStack.has(neighbor)) {
        return true; // 发现后向边（环）
      }
    }

    inStack.delete(node);
    return false;
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      if (dfs(node)) return true;
    }
  }

  return false;
}

export function getCanvasLayout(db: DB, canvasKey: string): CanvasLayout | null {
  const row = db.prepare('SELECT * FROM canvas_layout WHERE canvas_key=?').get(canvasKey) as CanvasLayoutRow | undefined;
  return row ? fromRow(row) : null;
}

export function saveCanvasLayout(db: DB, canvasKey: string, layout: CanvasLayoutData): CanvasLayout {
  // 防环校验
  if (layout.edges && hasCycleInEdges(layout.edges)) {
    throw new AppError(ErrorCode.VALIDATION, '画布连线检测到循环依赖（环路），工作流必须是无环有向图 (DAG)');
  }

  const now = nowIso();
  const existing = db.prepare('SELECT * FROM canvas_layout WHERE canvas_key=?').get(canvasKey) as CanvasLayoutRow | undefined;

  if (existing) {
    const nextVersion = existing.version + 1;
    db.prepare(
      'UPDATE canvas_layout SET layout_json=?, version=?, updated_at=? WHERE id=?',
    ).run(JSON.stringify(layout), nextVersion, now, existing.id);
    return fromRow(db.prepare('SELECT * FROM canvas_layout WHERE id=?').get(existing.id) as CanvasLayoutRow);
  }

  const id = shortId('cl_');
  db.prepare(
    'INSERT INTO canvas_layout (id, canvas_key, layout_json, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  ).run(id, canvasKey, JSON.stringify(layout), now, now);
  return fromRow(db.prepare('SELECT * FROM canvas_layout WHERE id=?').get(id) as CanvasLayoutRow);
}
