/**
 * vitest 全局环境默认值（workspace 治理批次1，2026-08-20）。
 *
 * 根治「单测泄漏真实目录」一类问题：MUSTER_HOME 未显式设置时默认指到临时目录——
 * 所有经 defaultWorkspaceRoot()/worktreeRoot()/SERVER_CONFIG 的落盘（项目目录、
 * worktree、DB 单例路径）都进测试沙盒，不再触碰真实 ~/MusterWorkspace 与 ~/.muster。
 * 显式设置 MUSTER_HOME 的 spec 不受影响（??= 只补默认）。
 *
 * 注意：setupFiles 先于测试模块 import 执行，SERVER_CONFIG 读到的是本默认值。
 * 每个测试 fork 独立目录（进程 pid + 随机段），避免并发争抢；/tmp 由系统清理。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (!process.env.MUSTER_HOME) {
  const testHome = mkdtempSync(path.join(tmpdir(), `muster-vitest-${process.pid}-`));
  process.env.MUSTER_HOME = testHome;
  // 目录迁移白名单同步放行测试家（macOS tmpdir 在 /var/folders，不属默认 HOME:/tmp 根；
  // 仅在未显式设置时补默认，语义与生产默认一致 + 测试沙盒）
  if (!process.env.MUSTER_ALLOWED_ROOTS) {
    process.env.MUSTER_ALLOWED_ROOTS = `${process.env.HOME ?? '/tmp'}:/tmp:${testHome}`;
  }
}
