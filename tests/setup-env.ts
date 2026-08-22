/**
 * vitest 全局环境默认值（workspace 治理批次1，2026-08-20）。
 *
 * 根治「单测泄漏真实目录」一类问题：MUSTER_HOME 未显式设置时默认指到临时目录——
 * 所有经 defaultWorkspaceRoot()/worktreeRoot()/SERVER_CONFIG 的落盘（项目目录、
 * worktree、DB 单例路径）都进测试沙盒，不再触碰真实 ~/MusterWorkspace 与 ~/.muster。
 *
 * 注意：setupFiles 先于测试模块 import 执行，SERVER_CONFIG 读到的是本默认值。
 * 每个测试 fork 独立目录（进程 pid + 随机段），避免并发争抢；/tmp 由系统清理。
 *
 * 修复轮补强（合并后实测泄漏）：pool=forks 下一个 fork 串行跑多个测试文件，存量
 * 11 个 spec 的 afterEach `delete process.env.MUSTER_HOME`（自认为的清理）会让同
 * fork 后续文件的动态路径读取落回真实家目录。除一次性赋值外，再加全局 beforeEach
 * 自愈：任何用例开始前发现值被删立即补回。显式设置者不受影响（自愈仅在值为空时生效）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach } from 'vitest';

export const TEST_MUSTER_HOME_DEFAULT = mkdtempSync(path.join(tmpdir(), `muster-vitest-${process.pid}-`));

if (!process.env.MUSTER_HOME) {
  process.env.MUSTER_HOME = TEST_MUSTER_HOME_DEFAULT;
  // 目录迁移白名单同步放行测试家与系统 tmpdir（macOS tmpdir 在 /var/folders，不属默认
  // HOME:/tmp 根；集成 spec 的 makeTmpRoot 亦建在 tmpdir 下——G.0② readArtifactContent
  // 增白名单门后两者都必须放行，语义与生产默认一致 + 测试沙盒）；仅未显式设置时补默认
  if (!process.env.MUSTER_ALLOWED_ROOTS) {
    process.env.MUSTER_ALLOWED_ROOTS = `${process.env.HOME ?? '/tmp'}:/tmp:${TEST_MUSTER_HOME_DEFAULT}:${tmpdir()}`;
  }
}

// 自愈：被存量 spec 的 afterEach delete 后，下一个用例开始前补回沙盒默认值
beforeEach(() => {
  if (!process.env.MUSTER_HOME) {
    process.env.MUSTER_HOME = TEST_MUSTER_HOME_DEFAULT;
  }
});
