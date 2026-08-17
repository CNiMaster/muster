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

export type ExecutorTier = 'high' | 'standard' | 'low';

/** 任务档位判定（纯函数）：蜂群工蜂/辩手/轻量咨询 → low；计划/验收/裁决/请示/返工 → high；其余 standard。 */
export function taskExecutorTier(task: Task, assigneeRole?: string | null): ExecutorTier {
  const proto = (task.inputProtocol ?? {}) as Record<string, unknown>;
  const trigger = typeof proto.trigger === 'string' ? proto.trigger : '';
  const mode = typeof proto.mode === 'string' ? proto.mode : '';
  const lightweight = proto.lightweight === true;
  // low：高并发、单点难度低
  if (trigger === 'swarm_bee' || trigger === 'debate_round') return 'low';
  if (lightweight || proto.isDiscussion === true) return 'low';
  // high：错不起的调用
  if (mode === 'plan') return 'high';
  if (trigger === 'debate_verdict' || trigger === 'swarm_request') return 'high';
  if (proto.acceptanceReview || proto.type === 'business_rework') return 'high';
  if (assigneeRole === 'debate-judge') return 'high';
  return 'standard';
}

/** 任务是否需要 cli kind 执行体（命中 REQUIRES_CLI_SKILLS 的能力需求；供能力过滤用）。 */
export function taskNeedsCliKind(task: Task): boolean {
  const proto = (task.inputProtocol ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(proto.resolvedSkillIds) ? (proto.resolvedSkillIds as unknown[]) : [];
  if (ids.length === 0) return false;
  // REQUIRES_CLI_SKILLS 集合在 context.ts；此处按 skillId 前缀保守判定（避免循环依赖）
  return ids.some((id) => {
    const s = String(id);
    return /^(cli|shell|codex|claude|git|terminal|workspace)/.test(s);
  });
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
