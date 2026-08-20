/**
 * Workspace 对账（治理批次1，2026-08-20）：磁盘目录 ↔ 数据库记录 双向 diff。
 *
 * 只读，绝不删除。三类输出：
 * - orphanMarked：磁盘有目录、带软件 marker、但 DB 无记录——历史测试泄漏/已删记录残留，
 *   确认无主后可人工清理（对账脚本 dry-run 出清单）。
 * - unknown：磁盘有目录、无 marker、DB 也无记录——存量旧目录（marker 机制之前创建）或
 *   用户自建目录。**不提供自动清理建议**，由用户自行判断。
 * - ghostRecords：DB 有记录但磁盘目录不存在——用户手动挪走/删除，或迁移未完成。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/client';
import { getActiveWorkspace } from './workspace';
import { defaultWorkspaceRoot, readDirMarker, type DirMarker } from './workspace-layout';

export interface AuditEntry {
  dir: string;
  name: string;
  marker: DirMarker | null;
  sizeBytes: number;
}

export interface WorkspaceAudit {
  workspaceRoot: string;
  projects: {
    okCount: number;
    orphanMarked: AuditEntry[];
    unknown: AuditEntry[];
  };
  tasks: {
    okCount: number;
    orphanMarked: AuditEntry[];
    unknown: AuditEntry[];
  };
  system: { dir: string; okCount: number; orphanMarked: AuditEntry[]; unknown: AuditEntry[] };
  ghostRecords: Array<{ projectId: string; name: string; rootDir: string }>;
}

/** 粗算目录占用（逐层求和；出错按 0）。导出供回收站等域复用。 */
export function dirSizeBytes(dir: string): number {
  // 粗算目录占用（du 慢；这里逐层求和，出错按 0）。只统计到目录级即可满足人工判断。
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e);
      try {
        const st = statSync(p);
        if (st.isDirectory()) stack.push(p);
        else total += st.size;
      } catch {
        /* 权限/竞态：跳过 */
      }
    }
  }
  return total;
}

function listDirs(parent: string): string[] {
  if (!existsSync(parent)) return [];
  try {
    return readdirSync(parent).map((e) => join(parent, e)).filter((p) => {
      try {
        return statSync(p).isDirectory() && !p.endsWith('.DS_Store');
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** 对账（只读）。 */
export function auditWorkspace(db: DB): WorkspaceAudit {
  const workspaceRoot = getActiveWorkspace(db)?.rootDir ?? defaultWorkspaceRoot();

  const projectRows = db.prepare('SELECT id, name, root_dir FROM project').all() as Array<{ id: string; name: string; root_dir: string }>;
  const projectRoots = new Set(projectRows.map((r) => r.root_dir));
  const taskRoots = new Set(
    (db.prepare('SELECT repo_root_dir FROM project_task WHERE repo_root_dir IS NOT NULL').all() as Array<{ repo_root_dir: string }>).map((r) => r.repo_root_dir),
  );

  function scan(parent: string, knownRoots: Set<string>) {
    const ok: AuditEntry[] = [];
    const orphanMarked: AuditEntry[] = [];
    const unknown: AuditEntry[] = [];
    for (const dir of listDirs(parent)) {
      const marker = readDirMarker(dir);
      const entry: AuditEntry = {
        dir,
        name: dir.split('/').pop() ?? dir,
        marker,
        sizeBytes: -1, // 大小懒算：仅孤儿/未知条目才值得算
      };
      if (knownRoots.has(dir)) {
        ok.push(entry);
      } else if (marker?.managed) {
        entry.sizeBytes = dirSizeBytes(dir);
        orphanMarked.push(entry);
      } else {
        entry.sizeBytes = dirSizeBytes(dir);
        unknown.push(entry);
      }
    }
    return { ok, orphanMarked, unknown };
  }

  const projectsScan = scan(join(workspaceRoot, 'projects'), projectRoots);
  // tasks/ 按月分层：扫两层（月目录 → 载体目录）
  const tasksParent = join(workspaceRoot, 'tasks');
  const taskDirs: string[] = [];
  for (const monthDir of listDirs(tasksParent)) {
    const children = listDirs(monthDir);
    if (children.length > 0) taskDirs.push(...children);
    else taskDirs.push(monthDir); // 无 marker 无子目录的空月目录也纳入对账
  }
  const tasksOk: AuditEntry[] = [];
  const tasksOrphan: AuditEntry[] = [];
  const tasksUnknown: AuditEntry[] = [];
  for (const dir of taskDirs) {
    const marker = readDirMarker(dir);
    const entry: AuditEntry = { dir, name: dir.split('/').pop() ?? dir, marker, sizeBytes: -1 };
    if (taskRoots.has(dir)) tasksOk.push(entry);
    else if (marker?.managed) {
      entry.sizeBytes = dirSizeBytes(dir);
      tasksOrphan.push(entry);
    } else {
      entry.sizeBytes = dirSizeBytes(dir);
      tasksUnknown.push(entry);
    }
  }
  const systemScan = scan(join(workspaceRoot, '.system'), projectRoots);

  const ghostRecords = projectRows
    .filter((r) => r.root_dir && !existsSync(r.root_dir))
    .map((r) => ({ projectId: r.id, name: r.name, rootDir: r.root_dir }));

  return {
    workspaceRoot,
    projects: { okCount: projectsScan.ok.length, orphanMarked: projectsScan.orphanMarked, unknown: projectsScan.unknown },
    tasks: { okCount: tasksOk.length, orphanMarked: tasksOrphan, unknown: tasksUnknown },
    system: { dir: join(workspaceRoot, '.system'), okCount: systemScan.ok.length, orphanMarked: systemScan.orphanMarked, unknown: systemScan.unknown },
    ghostRecords,
  };
}
