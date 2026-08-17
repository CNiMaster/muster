/**
 * 执行器三级默认（阶段二任务 2.1；公司退役 D4-2：三级降两级——公司级档位字段退役）。
 *
 * 三级默认执行器：用户配置 primary（大活）/ secondary（标准）/ tertiary（小活），
 * 新建员工默认继承；派发任务时引擎按任务标签自动选级，未配置或不可用时自动降级。
 *
 * 优先级：员工显式绑定（executor_profile_id）> 全局级三级默认 > 平台 defaultProvider。
 */
import type { DB } from '../db/client';
import { getSetting } from './setting';
import { getExecutorProfile, type ExecutorProfile } from './executor-profile';
import { REQUIRES_CLI_SKILLS } from '../executors/context';
import type { Task } from './task';

export type ExecutorTier = 'primary' | 'secondary' | 'tertiary';

/** 任务标签 → 执行器级别。 */
export function tierForTask(task: Task): ExecutorTier {
  const proto = (task.inputProtocol ?? {}) as Record<string, unknown>;
  // 轻量任务：讨论/咨询/通知类（低消耗）
  if (task.isDiscussion === 1 || proto.lightweight === true || proto.consultation === true) {
    return 'tertiary';
  }
  // 重活：需要 CLI 能力的 skill
  const skillIds = Array.isArray(proto.requiredSkillIds)
    ? (proto.requiredSkillIds as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  if (skillIds.some((skillId) => REQUIRES_CLI_SKILLS.has(skillId))) {
    return 'primary';
  }
  return 'secondary';
}

/**
 * 三级默认执行器的降级顺序：目标级 → 更低级 → null。
 * 降级语义：目标级未配置（或 profile 不存在）时依次尝试更低的级别。
 */
const TIER_FALLBACK_ORDER: Record<ExecutorTier, ExecutorTier[]> = {
  primary: ['primary', 'secondary', 'tertiary'],
  secondary: ['secondary', 'tertiary'],
  tertiary: ['tertiary'],
};

/** 读取某一级生效的 profile id（公司退役 D4-2：仅全局级 system_setting）。 */
export function getTieredExecutorProfileId(
  db: DB,
  tier: ExecutorTier,
): string | null {
  const globalValue = getSetting(db, `executor_tier_${tier}_id`, '');
  return globalValue || null;
}

/**
 * 按任务选择三级默认执行器 profile（含降级）。
 * 返回 null = 三级均未配置或 profile 均不可用 → 调用方回退到 defaultProvider 链。
 */
export function selectTieredExecutorProfile(
  db: DB,
  task: Task,
): ExecutorProfile | null {
  const tier = tierForTask(task);
  for (const candidate of TIER_FALLBACK_ORDER[tier]) {
    const profileId = getTieredExecutorProfileId(db, candidate);
    if (!profileId) continue;
    try {
      const profile = getExecutorProfile(db, profileId);
      // 故障转移：不健康档案（连续失败/认证失效）跳过，沿降级链换备选
      if (profile.health === 'unhealthy') continue;
      return profile;
    } catch {
      // profile 已被删除：尝试下一级
      continue;
    }
  }
  return null;
}
