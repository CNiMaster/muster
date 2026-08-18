/**
 * 执行器档位（2026-08-17 池化统一：两套档位合成一套）。
 *
 * 旧模型档位（model_tier_economy/premium → 模型名字符串）退役：档位现在指向**执行器档案**（CLI/API 不分家），
 * 一个选择框选脑；API 档案自带 config.model，CLI 档案走该 CLI。档位判定逻辑（本模块）决定任务该走哪一档档案，
 * 健康过滤沿降级链由本模块与引擎共同完成。
 *
 * 设置键：executor_tier_high_id / executor_tier_standard_id / executor_tier_low_id（均为档案 id）；
 * 旧键兼容读取一个版本：high←primary、standard←secondary、low←tertiary；空 = 该档不指定（沿链条回落）。
 */
import type { Task } from './task';
import type { DB } from '../db/client';
import { getSetting } from './setting';
import { getExecutorProfile, type ExecutorProfile } from './executor-profile';
import { getExecutorManifest } from '../executors/manifests';
import { REQUIRES_CLI_SKILLS } from '../executors/context';

export type ExecutorTier = 'high' | 'standard' | 'low';

/** 任务档位判定（纯函数）：蜂群工蜂/辩手/轻量咨询/头脑风暴 → low；计划/验收/裁决/请示/返工 → high；其余 standard。 */
export function taskExecutorTier(task: Task, assigneeRole?: string | null): ExecutorTier {
  const proto = (task.inputProtocol ?? {}) as Record<string, unknown>;
  const trigger = typeof proto.trigger === 'string' ? proto.trigger : '';
  const mode = typeof proto.mode === 'string' ? proto.mode : '';
  const lightweight = proto.lightweight === true;
  // low：高并发、单点难度低（review I3：isDiscussion 列与 consultation 信号从旧分类器完整吸收）
  if (trigger === 'swarm_bee' || trigger === 'debate_round') return 'low';
  if (lightweight || proto.isDiscussion === true || proto.consultation === true) return 'low';
  if (task.isDiscussion === 1) return 'low';
  // high：错不起的调用
  if (mode === 'plan') return 'high';
  if (trigger === 'debate_verdict' || trigger === 'swarm_request') return 'high';
  if (proto.acceptanceReview || proto.type === 'business_rework') return 'high';
  if (assigneeRole === 'debate-judge') return 'high';
  return 'standard';
}

/** 任务是否需要 cli kind 执行体（命中 REQUIRES_CLI_SKILLS 的能力需求；B2 能力过滤用）。 */
export function taskNeedsCliKind(task: Task): boolean {
  const proto = (task.inputProtocol ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(proto.resolvedSkillIds) ? (proto.resolvedSkillIds as unknown[]) : [];
  if (ids.length > 0) return ids.some((id) => REQUIRES_CLI_SKILLS.has(String(id)));
  // 兼容旧链路：requiredSkillIds 也可能携带
  const required = Array.isArray(proto.requiredSkillIds) ? (proto.requiredSkillIds as unknown[]) : [];
  return required.some((id) => REQUIRES_CLI_SKILLS.has(String(id)));
}

function profileIsCli(profile: ExecutorProfile): boolean {
  try {
    return getExecutorManifest(profile.manifestId).kind === 'cli';
  } catch {
    return Boolean((profile.config as Record<string, unknown>).binaryPath);
  }
}

function resolveFrom(db: DB, newKey: string, legacyKey: string): ExecutorProfile | null {
  const raw = getSetting(db, newKey, '') || getSetting(db, legacyKey, '');
  const id = raw.trim();
  if (!id) return null;
  try {
    const profile = getExecutorProfile(db, id);
    // 故障转移：不健康档案跳过（调用方沿链条换备选）
    return profile.health === 'unhealthy' ? null : profile;
  } catch {
    return null; // 档案已被删除
  }
}

/** 档位 → 执行器档案（未配置/不健康/已删返回 null，调用方回落下一档或 legacy）。 */
export function resolveProfileForTier(db: DB, tier: ExecutorTier): ExecutorProfile | null {
  switch (tier) {
    case 'high': return resolveFrom(db, 'executor_tier_high_id', 'executor_tier_primary_id');
    case 'standard': return resolveFrom(db, 'executor_tier_standard_id', 'executor_tier_secondary_id');
    case 'low': return resolveFrom(db, 'executor_tier_low_id', 'executor_tier_tertiary_id');
  }
}

/**
 * B2 能力感知选档：从自然档开始，沿 高→标准→低 扫描，取第一个满足硬能力要求（需 CLI）的档案。
 * 返回 null = 三档无可用 → 引擎回落 legacy。健康过滤由 resolveProfileForTier 承担。
 */
export function selectProfileForTask(db: DB, tier: ExecutorTier, needsCli: boolean): ExecutorProfile | null {
  const settled = (tier === 'high') ? ['high', 'standard', 'low']
    : (tier === 'standard') ? ['standard', 'high', 'low']
      : ['low', 'high', 'standard'];
  for (const t of settled) {
    const profile = resolveProfileForTier(db, t as ExecutorTier);
    if (!profile) continue;
    if (needsCli && !profileIsCli(profile)) continue;
    return profile;
  }
  return null;
}
