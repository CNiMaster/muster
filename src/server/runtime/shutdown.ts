/**
 * L1 优雅关机序列：让所有 online 公司先"下班"（排空手头任务）再退出，
 * 避免直接关闭导致任务失败出错。
 *
 * beginGracefulShutdown（company.ts）负责标记+转 draining；
 * 本模块负责等待收尾完成（coordinator 继续 tick 把 draining 公司 settle 到 off），
 * 超时兜底后回调 onComplete（由调用方停止引擎/关闭进程）。
 */
import { getDb } from '../db/client';
import { beginGracefulShutdown, getCompany } from '../domain/company';
import { log } from '../logger';

const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;

export function startGracefulShutdownSequence(opts: {
  onComplete?: () => void;
  timeoutMs?: number;
} = {}): Array<{ id: string; name: string }> {
  const db = getDb();
  const affected = beginGracefulShutdown(db);
  void (async () => {
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const remaining = affected.filter((c) => {
        try {
          return getCompany(db, c.id).state !== 'off';
        } catch {
          return false;
        }
      });
      if (remaining.length === 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    log.info('graceful shutdown complete — 工作已保存，祝您生意兴隆，期待与您的再次相见', {
      companies: affected.map((c) => c.name),
    });
    opts.onComplete?.();
  })();
  return affected;
}
