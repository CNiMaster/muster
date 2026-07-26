/**
 * 项目准备流程状态机（B2 骨干）。
 *
 * HARD-GATE 设计（借鉴 superpowers brainstorming:12-14 的 HARD-GATE 模式，
 * 异步化改造为服务端校验）：每个状态跃迁有进入条件，违反则抛 AppError。
 * 闸门只校验「状态转换是否合法」，阶段产物内容校验留给 B4（当前骨架阶段全允许）。
 *
 * 详见 docs/superpowers/specs/2026-07-26-capability-platform-design.md D.1。
 */
import { PHASE_ORDER, type ProjectState } from './project';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { getProject, updateProject, type Project } from './project';

/**
 * 断言 state 转换合法。
 * 规则：
 * - 向前：必须按 PHASE_ORDER 顺序推进（drafting→researching→...→active）
 * - 向后：允许任意回流（researching→drafting 等，对应 spec C.3 回流机制）
 * - active↔paused：允许（现有暂停/恢复）
 * - active/paused → completed：允许
 * - 任意 → archived：允许
 * - idle → drafting：兼容历史项目进准备流程
 */
export function assertCanTransition(from: ProjectState, to: ProjectState): void {
  if (from === to) return; // 同态无操作

  // 回流：to 在 PHASE_ORDER 中且 index 严格小于 from
  const fromIdx = PHASE_ORDER.indexOf(from);
  const toIdx = PHASE_ORDER.indexOf(to);
  if (fromIdx >= 0 && toIdx >= 0 && toIdx < fromIdx) return; // 合法回流

  // 准备阶段内的合法向前跃迁（PHASE_ORDER 中相邻后继）
  if (fromIdx >= 0 && toIdx === fromIdx + 1) return;

  // active ↔ paused（开工后的暂停/恢复，与准备流程正交）
  if ((from === 'active' && to === 'paused') || (from === 'paused' && to === 'active')) return;

  // 终态：active/paused → completed
  if (to === 'completed' && (from === 'active' || from === 'paused')) return;

  // 归档：任意非终态 → archived
  if (to === 'archived' && from !== 'completed' && from !== 'archived') return;

  // idle 兼容：历史 idle 项目 → drafting（进入准备流程）
  if (from === 'idle' && to === 'drafting') return;

  throw new AppError(
    ErrorCode.TASK_INVALID_TRANSITION,
    `非法项目状态转换：${from} → ${to}。准备阶段必须按 drafting→researching→equipping→staffing→ready→active 顺序推进，或回到前序阶段。`,
  );
}

/**
 * 执行阶段跃迁：校验合法性后更新 project.state。
 * 返回更新后的 project 与 previousState。lifecycle event 由调用方（API 路由）发布。
 */
export function transitionProjectPhase(
  db: DB,
  projectId: string,
  target: ProjectState,
): { project: Project; previousState: ProjectState } {
  const project = getProject(db, projectId);
  const previousState = project.state;
  assertCanTransition(previousState, target);
  const updated = updateProject(db, projectId, { state: target });
  return { project: updated, previousState };
}

/**
 * 派工闸门：项目必须处于 active 才能派工。
 * 与现有 task.ts:225 的 assertProjectLaunchConfirmed（任务级闸门）正交，两层叠加。
 */
export function assertProjectActive(db: DB, projectId: string): void {
  const project = getProject(db, projectId);
  if (project.state !== 'active') {
    throw new AppError(
      ErrorCode.PROJECT_INACTIVE,
      `项目尚未开工（当前状态：${project.state}）。请先完成准备流程并确认开工。`,
      { details: { state: project.state } },
    );
  }
}
