/**
 * 项目准备流程内容（B4）。
 *
 * readiness 存 project.settings.onboarding（命名空间隔离，避免与
 * milestoneReviewAt/dailyDiscussionBudgetUSD 等现有 key 碰撞）。
 *
 * validatePhaseExit 在 transitionProjectPhase 内调用，校验向前跃迁的阶段产物。
 * 回流（toIdx < fromIdx）不校验，全允许（spec C.3 回流机制）。
 */
import type { DB } from '../db/client';
import { getProject, updateProject, type ProjectState } from './project';
import {
  projectReadinessSchema,
  emptyProjectReadiness,
  type ProjectReadiness,
} from '../../shared/project-readiness';
import { AppError, ErrorCode } from '../../shared/errors';

const ONBOARDING_KEY = 'onboarding';

/** 读取 project.settings.onboarding，容错解析为 ProjectReadiness。 */
export function getProjectReadiness(db: DB, projectId: string): ProjectReadiness {
  const project = getProject(db, projectId);
  const raw = (project.settings as Record<string, unknown>)?.[ONBOARDING_KEY];
  const parsed = projectReadinessSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyProjectReadiness();
}

/**
 * 写 readiness（合并到 settings.onboarding，保留其他 settings key）。
 * 注意：updateProject 的 settings 是整体覆盖，所以要先 {...cur, onboarding: next}。
 */
export function setProjectReadiness(db: DB, projectId: string, readiness: ProjectReadiness): ProjectReadiness {
  const project = getProject(db, projectId);
  const validated = projectReadinessSchema.parse(readiness);
  const nextSettings = { ...(project.settings as Record<string, unknown>), [ONBOARDING_KEY]: validated };
  updateProject(db, projectId, { settings: nextSettings });
  return validated;
}

const PHASE_ORDER: ProjectState[] = [
  'drafting',
  'researching',
  'equipping',
  'staffing',
  'ready',
  'active',
];

/**
 * 校验向前阶段跃迁的产物完整性（回流不校验）。
 * 在 transitionProjectPhase 内、assertCanTransition 之后调用。
 */
export function validatePhaseExit(db: DB, projectId: string, from: ProjectState, to: ProjectState): void {
  const fromIdx = PHASE_ORDER.indexOf(from);
  const toIdx = PHASE_ORDER.indexOf(to);
  // 回流或非准备阶段，全允许
  if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) return;

  const r = getProjectReadiness(db, projectId);
  const gap = (label: string, detail: string): never => {
    throw new AppError(ErrorCode.VALIDATION, `阶段校验未通过（${label}）：${detail}`);
  };

  switch (`${from}->${to}`) {
    case 'drafting->researching':
      if (!r.draft.goal.trim()) gap('构思', '请先填写项目目标');
      return;
    case 'researching->equipping':
      if (!r.research.summary.trim()) gap('调研', '请先填写调研摘要');
      if (r.research.candidateSkills.length === 0 && r.research.candidateTools.length === 0) {
        gap('调研', '请至少选定一个候选能力（skill 或 tool）');
      }
      return;
    case 'equipping->staffing':
      if (r.equipment.enabledPlugins.length === 0) {
        gap('装备', '请至少启用一个能力（plugin）');
      }
      return;
    case 'staffing->ready':
      if (r.staffing.employeeIds.length === 0) gap('员工', '请至少分配一名员工到项目');
      return;
    case 'ready->active':
      if (!r.draft.goal.trim()) gap('就绪', '构思阶段缺少目标');
      if (!r.research.summary.trim()) gap('就绪', '调研阶段缺少摘要');
      if (r.equipment.enabledPlugins.length === 0) gap('就绪', '装备阶段未启用能力');
      if (r.staffing.employeeIds.length === 0) gap('就绪', '员工阶段未分配员工');
      return;
    default:
      return;
  }
}
