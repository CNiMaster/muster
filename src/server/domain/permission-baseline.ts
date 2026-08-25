/**
 * 基线权限守卫（P0 安全默认值反转，2026-08-25）。
 *
 * 背景：消息不带执行模式、员工与公司均未配置权限策略时，engine.buildPermissionGuard
 * 原本返回 undefined → executeTool 守卫块整体短路，API 执行器全部内置工具零审批执行
 * （fail-open）。现改为返回本基线守卫（fail-closed）：
 * - 读 / worktree 内写 / 联网 / 普通命令放行——worktree 内编辑有 git 可逆兜底，
 *   越界写另有 seatbelt OS 围栏拒绝（guardedSpawn writableRoots）；
 * - 八类高危动作直接拒绝，错误文本指导用户补配置。
 *
 * 设计约束：只做「放行/拒绝」二元判定，绝不进人工审批队列——基线场景没有权限策略 id，
 * 建不了审批单；若在这里阻塞等审批会把任务拖死。模型收到拒绝文本后可向用户说明并收尾。
 */

/** 与 permission.ts HIGH_RISK / ai-approval HARD_HIGH_RISK 同源的高危动作名（超集，多拒不错放）。 */
export const BASELINE_DENIED_ACTIONS = new Set([
  'git-push',
  'system-install',
  'deploy',
  'credential-access',
  'delete-outside-project',
  'external-message',
  'account-action',
  'paid-action',
]);

const DENY_MESSAGE =
  '已拒绝：当前未配置权限策略且本次消息未选择执行模式，高危动作按安全默认值一律拒绝' +
  '（git push / 全局安装 / 部署 / 凭据访问 / 对外发送等）。' +
  '请在发送消息时选择执行模式，或为该员工配置权限策略后重试。';

export type BaselinePermissionGuard = (
  request: { action: string; path?: string; command?: string },
) => Promise<{ allowed: boolean; message?: string }>;

export function createBaselinePermissionGuard(): BaselinePermissionGuard {
  return async (request) => {
    if (BASELINE_DENIED_ACTIONS.has(request.action)) {
      return { allowed: false, message: DENY_MESSAGE };
    }
    // read-file / write-file / network / run-command 直接放行；
    // execute-command 在 runCommandHandler 内还会用 classifyCommand 二次分级后
    // 再过一次本守卫，高危子类在那里被拒。
    return { allowed: true };
  };
}
