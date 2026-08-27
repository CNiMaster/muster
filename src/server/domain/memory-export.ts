/**
 * 选择闭环 S5（spec 2026-08-27-selection-loop）：记忆可见性与迁移。
 *
 * 定案口径：
 * - 记忆住中心 DB，永不进项目文件夹（spec 原则 8）——导出面是**视图不是事实源**：
 *   按项目导出的 Markdown/JSON 随时可再生成，不承担同步职责。
 * - bundle 精确裁剪：只带 project scope（该项目记忆），**绝不带 personal（用户偏好不随包误送）
 *   /craft（人设手艺）/workspace（平台经验属本机环境）**——换机/移交同事的安全边界。
 * - 导入走真实管道（createMemoryCandidate → 审批 → FTS 索引），fingerprint 去重幂等。
 */
import type { DB } from '../db/client';
import { nowIso } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';
import { getProject } from './project';
import { createMemoryCandidate } from './memory';

export interface ExportedMemoryEntry {
  id: string;
  content: string;
  fingerprint: string | null;
  state: string;
  hitCount: number;
  voteCount: number;
  updatedAt: string;
}

function projectScopedEntries(db: DB, projectId: string): ExportedMemoryEntry[] {
  return db.prepare(
    `SELECT id, content, fingerprint, state, hit_count AS hitCount, vote_count AS voteCount, updated_at AS updatedAt
     FROM memory_entry
     WHERE project_id=? AND scope='project' AND state IN ('active','locked')
     ORDER BY updated_at DESC, id`,
  ).all(projectId) as ExportedMemoryEntry[];
}

export interface ProjectMemoryExport {
  filename: string;
  content: string;
  format: 'markdown' | 'json';
  count: number;
}

/** 按项目导出（视图非事实源）：Markdown 人读友好 / JSON 机读。 */
export function exportProjectMemory(db: DB, projectId: string, format: 'markdown' | 'json' = 'markdown'): ProjectMemoryExport {
  const project = getProject(db, projectId);
  const entries = projectScopedEntries(db, projectId);
  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = project.name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const filename = `muster-memory-${safeName}-${stamp}.${format === 'json' ? 'json' : 'md'}`;
  const content =
    format === 'json'
      ? JSON.stringify({ kind: 'muster-project-memory', version: 1, projectId, projectName: project.name, exportedAt: nowIso(), entries }, null, 2)
      : [
          `# 项目记忆：${project.name}`,
          '',
          `> muster 导出视图（${new Date().toISOString()}）——非事实源，可在记忆看板随时再生成。共 ${entries.length} 条。`,
          '',
          ...entries.map((e) => `- ${e.content}${e.state === 'locked' ? ' 🔒' : ''}（更新 ${e.updatedAt.slice(0, 10)}，出场 ${e.hitCount}）`),
        ].join('\n');
  return { filename, content, format, count: entries.length };
}

/** bundle 结构（导入导出协议 v1）。 */
export interface MemoryBundle {
  kind: 'muster-memory-bundle';
  version: 1;
  exportedAt: string;
  source: { projectName: string };
  entries: Array<{ content: string; fingerprint: string | null }>;
}

/** 导出迁移 bundle：只带 project scope（精确裁剪——personal/craft/workspace 不随包误送）。 */
export function exportMemoryBundle(db: DB, projectId: string): { filename: string; bundle: MemoryBundle; count: number } {
  const project = getProject(db, projectId);
  const entries = projectScopedEntries(db, projectId);
  const bundle: MemoryBundle = {
    kind: 'muster-memory-bundle',
    version: 1,
    exportedAt: nowIso(),
    source: { projectName: project.name },
    entries: entries.map((e) => ({ content: e.content, fingerprint: e.fingerprint })),
  };
  const safeName = project.name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return { filename: `muster-bundle-${safeName}-${new Date().toISOString().slice(0, 10)}.json`, bundle, count: entries.length };
}

export interface BundleImportResult {
  imported: number;
  skippedDuplicate: number;
}

function isBundle(value: unknown): value is MemoryBundle {
  const b = value as MemoryBundle;
  return (
    typeof b === 'object' && b !== null &&
    b.kind === 'muster-memory-bundle' && b.version === 1 &&
    typeof b.source === 'object' && b.source !== null && typeof b.source.projectName === 'string' &&
    Array.isArray(b.entries) && b.entries.every((e) => typeof e?.content === 'string')
  );
}

/**
 * 导入 bundle 到指定项目（换机/移交同事；targetProjectId 必填——导入方有自己的项目结构，
 * 不按名字自动建项目）。走 createMemoryCandidate 真实管道（FTS/版本化自动），
 * fingerprint 命中现有条目则跳过（幂等）。
 */
export function importMemoryBundle(db: DB, rawBundle: unknown, targetProjectId: string): BundleImportResult {
  if (!isBundle(rawBundle)) {
    throw new AppError(ErrorCode.VALIDATION, '不是有效的 muster 记忆 bundle（kind/version 不符）');
  }
  const project = getProject(db, targetProjectId);
  void project;
  let imported = 0;
  let skippedDuplicate = 0;
  const existingFps = new Set(
    (db.prepare(
      `SELECT DISTINCT fingerprint FROM memory_entry WHERE project_id=? AND scope='project' AND fingerprint IS NOT NULL`,
    ).all(targetProjectId) as Array<{ fingerprint: string }>).map((r) => r.fingerprint),
  );
  for (const e of rawBundle.entries.slice(0, 500)) {
    if (e.fingerprint && existingFps.has(e.fingerprint)) {
      skippedDuplicate++;
      continue;
    }
    createMemoryCandidate(db, {
      profileId: resolveHostProfileId(db),
      scope: 'project',
      projectId: targetProjectId,
      content: e.content,
      fingerprint: e.fingerprint ?? undefined,
      author: 'user',
      confidence: 1,
      canInfluence: true,
      allowAutoApprove: true,
      cause: 'context', // 合法枚举内（'bundle-import' 会被 isMemoryCause 置 null，留痕改走 fingerprint 前缀）
    });
    if (e.fingerprint) existingFps.add(e.fingerprint);
    imported++;
  }
  return { imported, skippedDuplicate };
}

/** bundle 宿主档案：工作台首个档案（导入记忆不绑定具体员工——项目记忆按 project_id 召回）。 */
function resolveHostProfileId(db: DB): string {
  const row = db.prepare(`SELECT id FROM agent_profile ORDER BY created_at LIMIT 1`).get() as { id: string } | undefined;
  if (!row) throw new AppError(ErrorCode.VALIDATION, '尚无任何员工档案，无法导入记忆（先完成初始化）');
  return row.id;
}
