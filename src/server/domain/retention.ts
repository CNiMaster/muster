/**
 * 过期信息清理（批次 L5+L6，盘点制用户拍板）：trace 事件/审计日志按 TTL 归档后删除——
 * 归档 JSONL.gz 到 MUSTER_HOME/backups/archive/（保留 TTL 两倍时长）=隔离区语义（可找回，不直接删）；
 * 清理后触发 wal_checkpoint(TRUNCATE)+VACUUM 回收空间。TTL 单源在此。
 */
import type { DB } from '../db/client';
import { mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { nowIso } from '../../shared/utils';
import { log } from '../logger';

export const TTL_TRACE_EVENT_DAYS = 90;
export const TTL_AUDIT_DAYS = 180;
/** 归档保留 = 对应 TTL 的两倍。 */
const ARCHIVE_KEEP_FACTOR = 2;
const ARCHIVE_KEEP_MAX = 20; // 归档文件滚动上限（防 archive 自身无限涨）

interface Cutoff { cutoff: string; count: number }
function traceCutoff(db: DB): Cutoff {
  const cutoff = new Date(Date.now() - TTL_TRACE_EVENT_DAYS * 86400_000).toISOString();
  const { n } = db.prepare('SELECT COUNT(*) n FROM execution_trace WHERE occurred_at < ?').get(cutoff) as { n: number };
  return { cutoff, count: n };
}
function auditCutoff(db: DB): Cutoff {
  const cutoff = new Date(Date.now() - TTL_AUDIT_DAYS * 86400_000).toISOString();
  const { n } = db.prepare('SELECT COUNT(*) n FROM permission_audit WHERE created_at < ?').get(cutoff) as { n: number };
  return { cutoff, count: n };
}

export interface CleanupPreview {
  traceEvents: Cutoff & { ttlDays: number; sample: Array<{ id: string; kind: string; occurredAt: string }> };
  audits: Cutoff & { ttlDays: number; sample: Array<{ id: string; action: string; createdAt: string }> };
}

export function previewCleanup(db: DB): CleanupPreview {
  const t = traceCutoff(db);
  const a = auditCutoff(db);
  return {
    traceEvents: {
      ...t, ttlDays: TTL_TRACE_EVENT_DAYS,
      sample: db.prepare('SELECT id, kind, occurred_at AS occurredAt FROM execution_trace WHERE occurred_at < ? ORDER BY occurred_at DESC LIMIT 10').all(t.cutoff) as CleanupPreview['traceEvents']['sample'],
    },
    audits: {
      ...a, ttlDays: TTL_AUDIT_DAYS,
      sample: db.prepare('SELECT id, action, created_at AS createdAt FROM permission_audit WHERE created_at < ? ORDER BY created_at DESC LIMIT 10').all(a.cutoff) as CleanupPreview['audits']['sample'],
    },
  };
}

function archiveRows(db: DB, kind: 'trace-events' | 'permission-audit', cutoff: string, home: string): { archived: number; file: string | null } {
  const rows = kind === 'trace-events'
    ? db.prepare('SELECT * FROM execution_trace WHERE occurred_at < ?').all(cutoff)
    : db.prepare('SELECT * FROM permission_audit WHERE created_at < ?').all(cutoff);
  if (rows.length === 0) return { archived: 0, file: null };
  const dir = path.join(home, 'backups', 'archive');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${kind}.jsonl.gz`);
  writeFileSync(file, gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8')));
  // 滚动：按 mtime 只留最近 N 份
  const all = readdirSync(dir).filter((f) => f.endsWith('.jsonl.gz')).map((f) => ({ f, m: statSync(path.join(dir, f)).mtimeMs })).sort((x, y) => y.m - x.m);
  for (const extra of all.slice(ARCHIVE_KEEP_MAX)) rmSync(path.join(dir, extra.f), { force: true });
  return { archived: rows.length, file };
}

export interface CleanupResult {
  traceArchived: number; traceDeleted: number;
  auditArchived: number; auditDeleted: number;
  vacuumed: boolean;
  archiveFiles: Array<string | null>;
}

/** 执行清理（用户在预览后确认调用）：归档→删除→checkpoint+VACUUM。 */
export function executeCleanup(db: DB, opts: { traceEvents?: boolean; audits?: boolean } = {}): CleanupResult {
  const home = process.env.MUSTER_HOME ?? path.join(process.env.HOME ?? '/tmp', '.muster');
  const result: CleanupResult = { traceArchived: 0, traceDeleted: 0, auditArchived: 0, auditDeleted: 0, vacuumed: false, archiveFiles: [] };
  db.transaction(() => {
    if (opts.traceEvents !== false) {
      const t = traceCutoff(db);
      if (t.count > 0) {
        const a = archiveRows(db, 'trace-events', t.cutoff, home);
        const d = db.prepare('DELETE FROM execution_trace WHERE occurred_at < ?').run(t.cutoff);
        result.traceArchived = a.archived; result.traceDeleted = d.changes; result.archiveFiles.push(a.file);
      }
    }
    if (opts.audits !== false) {
      const a = auditCutoff(db);
      if (a.count > 0) {
        const arch = archiveRows(db, 'permission-audit', a.cutoff, home);
        const d = db.prepare('DELETE FROM permission_audit WHERE created_at < ?').run(a.cutoff);
        result.auditArchived = arch.archived; result.auditDeleted = d.changes; result.archiveFiles.push(arch.file);
      }
    }
  })();
  // L6：清理后回收空间（WAL 截断+VACUUM——低频只在清理动作触发）
  if (result.traceDeleted + result.auditDeleted > 0) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.pragma('vacuum');
      result.vacuumed = true;
    } catch (e) {
      log.warn('cleanup vacuum failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }
  log.info('retention cleanup executed', { ...result, at: nowIso() });
  return result;
}
