/**
 * 运行目录清扫：~/.muster/runs/<runId>（每次执行的 tmp/logs 隔离目录）。
 *
 * 这些目录没有消费侧的清理链路，会随执行次数线性累积（构建时创建、任务结束后无人删）。
 * 此处按目录 mtime 做 TTL 清扫（默认 14 天），服务启动时跑一次。
 * 边界：只删 runs/ 下的直接子目录——不碰 agents/（会话目录属员工资产，分身/工蜂各有
 * 生命周期管理）与 worktrees/（由任务终态清理与等待态保留语义管理）。
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { SERVER_CONFIG } from '../env';
import { log } from '../logger';

export const RUN_DIR_MAX_AGE_DAYS_DEFAULT = 14;

export function sweepStaleRunDirs(maxAgeDays: number = RUN_DIR_MAX_AGE_DAYS_DEFAULT): { removed: number } {
  const runsRoot = path.join(process.env.MUSTER_HOME ?? SERVER_CONFIG.musterDir, 'runs');
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(runsRoot);
  } catch {
    return { removed }; // 目录不存在（从未执行过）视为正常
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    const dir = path.join(runsRoot, name);
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      if (st.mtimeMs < cutoff) {
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch (e) {
      log.warn('run dir sweep entry failed', { dir, err: String(e) });
    }
  }
  if (removed > 0) log.info('stale run dirs swept', { removed, maxAgeDays });
  return { removed };
}
