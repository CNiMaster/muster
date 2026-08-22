/**
 * 批次 H.4：任务 worktree 媒体文件自动预览回流。
 *
 * 动机：codex/自定义 CLI 与 Bash 生图等写入没有工具回调路径，用户在任务运行中看不到
 * 生成物。周期扫描 worktree 新增媒体文件并发 preview trace（origin='worktree'），
 * 前端经任务级文件端点直读 worktree——生图立刻可见；正式入产物库仍走发布白名单门禁。
 */
import { readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client';
import { appendTrace } from '../domain/execution-trace';

const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.html', '.htm']);

/**
 * 扫描 worktree 内的媒体文件并为新增者发 preview trace。
 * @param emitted 本次 run 内已发过的相对路径集合（跨调用累计去重；trace 上限 500 会裁老条目，
 *                故去重以运行期内存为准）
 * @returns 新发的 preview 条数
 */
export function scanWorktreeMediaPreviews(
  db: DB,
  taskId: string,
  runId: string | null | undefined,
  rootPath: string,
  emitted: Set<string>,
): number {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, depth + 1);
      } else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(path.relative(rootPath, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(rootPath, 0);

  let added = 0;
  for (const rel of found) {
    if (emitted.has(rel)) continue;
    emitted.add(rel);
    try {
      appendTrace(db, {
        taskId,
        ...(runId ? { runId } : {}),
        kind: 'preview',
        summary: `生成文件 ${rel}`,
        payload: { text: `生成文件 ${rel}`, path: rel, origin: 'worktree' },
      });
      added += 1;
    } catch {
      // trace 失败不影响扫描
    }
  }
  return added;
}
