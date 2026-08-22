/**
 * 防休眠保活（批次 G.5）。
 *
 * 背景：muster 服务端跑在用户机器上，系统睡眠 = 协调器停摆 + 局域网断服（桌面版定调
 * 2026-08-22：后期桌面版；网页服务局域网手机 + P2P 远程控制）。
 *
 * 设置 prevent_sleep：'active'（默认，有正式活跃任务或 trigger 临近触发时保活）
 * | 'always'（常驻）| 'off'。
 * 实现：仅 darwin 用系统内建 caffeinate（-i 阻空闲休眠，-s 阻交流电休眠，零依赖）；
 * 其他平台启动时记一次日志留待桌面打包期。30s 自有 timer 评估；stop() 进优雅关停链
 * （强退/优雅两路都已覆盖）。已知残留：SIGKILL/断电等异常退出会留孤儿 caffeinate
 * （机器保持不休眠直到它被手动 kill）——权衡后接受，属"宁可不睡"方向。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { DB } from '../db/client';
import { getSetting } from '../domain/setting';
import { countActiveTasks } from '../domain/task';
import { log } from '../logger';

const CHECK_INTERVAL_MS = 30_000;
const TRIGGER_DUE_WINDOW_MS = 5 * 60_000;

function hasUpcomingTrigger(db: DB): boolean {
  const cutoff = new Date(Date.now() + TRIGGER_DUE_WINDOW_MS).toISOString();
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM trigger WHERE next_run_at IS NOT NULL AND next_run_at <= ?')
    .get(cutoff) as { n: number };
  return row.n > 0;
}

export class KeepAwake {
  private timer: NodeJS.Timeout | null = null;
  private child: ChildProcess | null = null;
  private unsupportedNotified = false;

  constructor(private readonly db: DB) {}

  start(): void {
    if (this.timer) return;
    if (process.platform !== 'darwin') {
      if (!this.unsupportedNotified) {
        this.unsupportedNotified = true;
        log.info('keepawake: 当前平台无内建保活命令，防休眠停用（桌面打包期补 Windows/Linux）', {
          platform: process.platform,
        });
      }
      return;
    }
    this.timer = setInterval(() => {
      try {
        this.evaluate();
      } catch (err) {
        log.warn('keepawake evaluate failed', { err: String(err) });
      }
    }, CHECK_INTERVAL_MS);
    this.timer.unref?.();
    this.evaluate();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.killChild();
  }

  /** 测试与运维观测用：当前是否持有保活子进程。 */
  isHolding(): boolean {
    return this.child !== null;
  }

  private evaluate(): void {
    const mode = getSetting(this.db, 'prevent_sleep', 'active');
    const shouldHold =
      mode === 'always' || (mode === 'active' && (countActiveTasks(this.db) > 0 || hasUpcomingTrigger(this.db)));
    if (shouldHold && !this.child) {
      const child = spawn('caffeinate', ['-i', '-s'], { stdio: 'ignore' });
      this.child = child;
      // 外部退出（用户手动 kill 等）：清引用，下轮评估可重拉
      child.on('exit', () => {
        if (this.child === child) this.child = null;
      });
      child.on('error', (err) => {
        log.warn('keepawake: caffeinate 启动失败', { err: err.message });
        if (this.child === child) this.child = null;
      });
      log.info('keepawake: caffeinate 已启动（防休眠生效）');
    } else if (!shouldHold && this.child) {
      this.killChild();
      log.info('keepawake: caffeinate 已停止（保活条件不满足）');
    }
  }

  private killChild(): void {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try {
      child.kill('SIGTERM');
    } catch {
      // 已退出则忽略
    }
  }
}
