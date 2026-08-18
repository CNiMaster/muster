/**
 * Relationship 领域：组织图 + 通信图。
 *
 - 用 kind='org' / 'communication' 区分两种图。
 - 上班期间（公司非 off）禁止修改。
 - 校验：通信边两端必须都在 contact_allow 列表（保存时由调用方触发校验）。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getWorkbench } from './workbench';
import type { GraphKind } from '../../shared/types';
import { getAgent } from './agent';

export interface Relationship {
  id: string;
  companyId: string;
  kind: GraphKind;
  sourceId: string;
  targetId: string;
  label: string;
  protocol: Record<string, unknown>;
  createdAt: string;
  archivedAt: string | null;
}

interface RelationshipRow {
  id: string;
  kind: GraphKind;
  source_id: string;
  target_id: string;
  label: string;
  protocol_json: string;
  created_at: string;
  archived_at: string | null;
}

function fromRow(db: DB, r: RelationshipRow): Relationship {
  return {
    id: r.id,
    companyId: getWorkbench(db).id,
    kind: r.kind,
    sourceId: r.source_id,
    targetId: r.target_id,
    label: r.label,
    protocol: JSON.parse(r.protocol_json ?? '{}'),
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

function assertUnlocked(db: DB): void {
  if (getWorkbench(db).state !== 'off') {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '上班期间不能修改关系图');
  }
}

export function addRelationship(
  db: DB,
  input: { kind: GraphKind; sourceId: string; targetId: string; label?: string; protocol?: Record<string, unknown> },
): Relationship {
  assertUnlocked(db);
  if (input.sourceId === input.targetId) {
    throw new AppError(ErrorCode.VALIDATION, '不能自引用关系');
  }
  getAgent(db, input.sourceId);
  getAgent(db, input.targetId);
  const id = shortId('rel_');
  db.transaction(() => {
    db.prepare(
      `INSERT INTO relationship (id, kind, source_id, target_id, label, protocol_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.kind, input.sourceId, input.targetId, input.label ?? '', JSON.stringify(input.protocol ?? {}), nowIso());
    if (input.kind === 'communication') {
      const source = getAgent(db, input.sourceId);
      const contacts = [...new Set([...source.contactAllow, input.targetId])];
      db.prepare('UPDATE agent_definition SET contact_allow_json=?, updated_at=? WHERE id=?').run(
        JSON.stringify(contacts),
        nowIso(),
        input.sourceId,
      );
    }
  })();
  return getRelationship(db, id);
}

export function getRelationship(db: DB, id: string): Relationship {
  const row = db.prepare('SELECT * FROM relationship WHERE id = ?').get(id) as RelationshipRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `relationship ${id} not found`);
  return fromRow(db, row);
}

/**
 列出关系。
 - includeArchived=false（默认）：只返回未归档关系（运行态使用）。
 - includeArchived=true：返回所有关系（前端展示归档态使用）。
 */
export function listRelationships(
  db: DB,
  kind?: GraphKind,
  opts: { includeArchived?: boolean } = {},
): Relationship[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  if (!opts.includeArchived) {
    where.push('archived_at IS NULL');
  }
  const sql = `SELECT * FROM relationship${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY archived_at IS NULL DESC, created_at`;
  const rows = db.prepare(sql).all(...params) as RelationshipRow[];
  return rows.map((row) => fromRow(db, row));
}

export function deleteRelationship(db: DB, id: string): void {
  const cur = getRelationship(db, id);
  assertUnlocked(db);
  db.transaction(() => {
    db.prepare('DELETE FROM relationship WHERE id = ?').run(id);
    if (cur.kind === 'communication') {
      const source = getAgent(db, cur.sourceId);
      const contacts = source.contactAllow.filter((contactId) => contactId !== cur.targetId);
      db.prepare('UPDATE agent_definition SET contact_allow_json=?, updated_at=? WHERE id=?').run(
        JSON.stringify(contacts),
        nowIso(),
        source.id,
      );
    }
  })();
}

/**
 归档关系（软删除，PRD:351-359）。
 归档态关系不出现在运行时图中，但前端可以灰色虚线展示，便于追溯历史组织。
 通信边归档时同步从 contact_allow 移除目标（避免运行态仍按旧权限通信）。
 */
export function archiveRelationship(db: DB, id: string): Relationship {
  const cur = getRelationship(db, id);
  assertUnlocked(db);
  db.transaction(() => {
    db.prepare('UPDATE relationship SET archived_at=? WHERE id=?').run(nowIso(), id);
    if (cur.kind === 'communication') {
      const source = getAgent(db, cur.sourceId);
      const contacts = source.contactAllow.filter((contactId) => contactId !== cur.targetId);
      db.prepare('UPDATE agent_definition SET contact_allow_json=?, updated_at=? WHERE id=?').run(
        JSON.stringify(contacts),
        nowIso(),
        source.id,
      );
    }
  })();
  return getRelationship(db, id);
}

/** 恢复归档关系。通信边恢复时同步把 target 重新加入 contact_allow。 */
export function restoreRelationship(db: DB, id: string): Relationship {
  const cur = getRelationship(db, id);
  assertUnlocked(db);
  db.transaction(() => {
    db.prepare('UPDATE relationship SET archived_at=NULL WHERE id=?').run(id);
    if (cur.kind === 'communication') {
      const source = getAgent(db, cur.sourceId);
      const contacts = [...new Set([...source.contactAllow, cur.targetId])];
      db.prepare('UPDATE agent_definition SET contact_allow_json=?, updated_at=? WHERE id=?').run(
        JSON.stringify(contacts),
        nowIso(),
        source.id,
      );
    }
  })();
  return getRelationship(db, id);
}

/**
 * 保存通信图前的校验：
 * - 每条 communication 边的 source 必须把 target 加入 contact_allow。
 * 返回错误列表（空表示通过）。
 */
export function validateCommunication(db: DB): string[] {
  const edges = listRelationships(db, 'communication');
  const errors: string[] = [];
  for (const e of edges) {
    const src = db.prepare('SELECT contact_allow_json FROM agent_definition WHERE id = ?').get(e.sourceId) as
      | { contact_allow_json: string }
      | undefined;
    if (!src) {
      errors.push(`通信边 ${e.id} 的源员工 ${e.sourceId} 不存在`);
      continue;
    }
    const allowed = JSON.parse(src.contact_allow_json ?? '[]') as string[];
    if (!allowed.includes(e.targetId)) {
      errors.push(`通信边 ${e.id} 非法：${e.sourceId} 未授权联系 ${e.targetId}`);
    }
  }
  return errors;
}
