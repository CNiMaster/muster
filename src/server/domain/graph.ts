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
import { isOrgLocked } from './company';
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
}

interface RelationshipRow {
  id: string;
  company_id: string;
  kind: GraphKind;
  source_id: string;
  target_id: string;
  label: string;
  protocol_json: string;
  created_at: string;
}

function fromRow(r: RelationshipRow): Relationship {
  return {
    id: r.id,
    companyId: r.company_id,
    kind: r.kind,
    sourceId: r.source_id,
    targetId: r.target_id,
    label: r.label,
    protocol: JSON.parse(r.protocol_json ?? '{}'),
    createdAt: r.created_at,
  };
}

function assertUnlocked(db: DB, companyId: string): void {
  if (isOrgLocked(db, companyId)) {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '上班期间不能修改关系图');
  }
}

export function addRelationship(
  db: DB,
  input: { companyId: string; kind: GraphKind; sourceId: string; targetId: string; label?: string; protocol?: Record<string, unknown> },
): Relationship {
  assertUnlocked(db, input.companyId);
  if (input.sourceId === input.targetId) {
    throw new AppError(ErrorCode.VALIDATION, '不能自引用关系');
  }
  const source = getAgent(db, input.sourceId);
  const target = getAgent(db, input.targetId);
  if (source.companyId !== input.companyId || target.companyId !== input.companyId) {
    throw new AppError(ErrorCode.VALIDATION, '关系图两端必须是本公司员工');
  }
  const id = shortId('rel_');
  db.transaction(() => {
    db.prepare(
      `INSERT INTO relationship (id, company_id, kind, source_id, target_id, label, protocol_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.companyId, input.kind, input.sourceId, input.targetId, input.label ?? '', JSON.stringify(input.protocol ?? {}), nowIso());
    if (input.kind === 'communication') {
      const contacts = [...new Set([...source.contactAllow, target.id])];
      db.prepare('UPDATE agent_definition SET contact_allow_json=?, updated_at=? WHERE id=?').run(
        JSON.stringify(contacts),
        nowIso(),
        source.id,
      );
    }
  })();
  return getRelationship(db, id);
}

export function getRelationship(db: DB, id: string): Relationship {
  const row = db.prepare('SELECT * FROM relationship WHERE id = ?').get(id) as RelationshipRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `relationship ${id} not found`);
  return fromRow(row);
}

export function listRelationships(db: DB, companyId: string, kind?: GraphKind): Relationship[] {
  const sql = kind
    ? 'SELECT * FROM relationship WHERE company_id = ? AND kind = ? ORDER BY created_at'
    : 'SELECT * FROM relationship WHERE company_id = ? ORDER BY created_at';
  const rows = (kind ? db.prepare(sql).all(companyId, kind) : db.prepare(sql).all(companyId)) as RelationshipRow[];
  return rows.map(fromRow);
}

export function deleteRelationship(db: DB, id: string): void {
  const cur = getRelationship(db, id);
  assertUnlocked(db, cur.companyId);
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
 * 保存通信图前的校验：
 * - 每条 communication 边的 source 必须把 target 加入 contact_allow。
 * 返回错误列表（空表示通过）。
 */
export function validateCommunication(db: DB, companyId: string): string[] {
  const edges = listRelationships(db, companyId, 'communication');
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
