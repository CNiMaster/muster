/**
 * 执行器能力分级（2026-08-25 批次，对齐 ZCode 子代理最小权限设计）。
 *
 * 背景：assembleTools 此前全员同一套工具（写/命令/付费全开），人设 tools_json 只是
 * 推荐文案不约束实际工具集。本模块定义工具档位：蜂档任务「事前就没有」写与命令
 * 工具——缩小爆炸半径、减少模型无效尝试，并与权限层的 deny 策略（bindDefaultDenyPolicy）
 * 形成双网：策略绑定失败自愈的场景由工具层兜底。
 *
 * v1 只有 bee 是收紧档；staff=现状全量（零回归）。判定纯运行时（无迁移）：
 *   ① agent.role === 'swarm-worker'（蜂群工蜂）
 *   ② task.inputProtocol.consultation === true（咨询分身——「读记忆不写记忆」定调）
 *   ③ task.inputProtocol.acceptanceReview 存在（验收评审任务——纯判定契约：读产物→
 *      VERDICT 汇报；与「立场独立性」配套，评审者不该自己动手改它正在审的东西）
 * 其余一律 staff（fail-open 到现状，不破坏自定义 agent）。
 *
 * 后续方向（独立批次）：人设 tools_json 升级为可覆盖白名单、CLI 侧蜂档强制 deny
 * 策略、员工/负责人差异化档位。
 */

export type ToolTier = 'bee' | 'staff';

/** 蜂档白名单：只读 + 调研联网 + 汇报协作。 */
export const BEE_TOOL_ALLOWLIST = new Set([
  'read_file',
  'list_files',
  'web_fetch',
  'web_search',
  'ask_colleague',   // 问专家=调研；被咨询者本身也是蜂档只读
  'notify_host',
  'notify_colleague',
  'submit_review',   // 产出走业务审批门，有自己的闸
  'done',
]);

// 排除项及理由（留档防遗忘）：
// - write_file / edit_file / run_command：写与命令，蜂档核心排除对象
// - spawn_tasks / cancel_child_task：蜂无子代
// - start_discussion / conclude_discussion：诱导他人行动
// - image_generate：付费 API
// - MCP 全部：外部工具不进蜂档

/** 按任务执行者与任务特征判定工具档位。判定异常一律回落 staff（fail-open 到现状）。 */
export function resolveToolTier(
  agent: { role?: string } | null | undefined,
  task: { inputProtocol?: unknown } | null | undefined,
): ToolTier {
  try {
    if (agent?.role === 'swarm-worker') return 'bee';
    const proto = task?.inputProtocol as Record<string, unknown> | null | undefined;
    if (proto?.consultation === true) return 'bee';
    if (proto?.acceptanceReview && typeof proto.acceptanceReview === 'object') return 'bee';
    return 'staff';
  } catch {
    return 'staff';
  }
}
