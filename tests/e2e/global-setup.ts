/**
 * E2E 全局 setup：清空固定 MUSTER_HOME，保证每次运行确定性纯净。
 * 公司退役批次C：原 `/tmp/muster-e2e-${pid}` 在 PID 回收时可能复用残留目录
 * （带上次运行的项目数据），导致「零项目态」等首用例撞上脏库。改为固定目录 + 每次清理。
 */
import { rmSync } from 'node:fs';

export default function globalSetup(): void {
  rmSync('/tmp/muster-e2e-run', { recursive: true, force: true });
}
