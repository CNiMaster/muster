/**
 * 模型档位（WP9 成本-能力匹配）。
 *
 * 执行器选择不动（员工绑定/三级默认保持）；本模块只在 effectiveExecutor 合成时
 * 决定「模型标识」是否按任务档位覆盖。优先级：用户显式指定（消息级/工作单 model）
 * > 档位默认 > 执行器档案 model。档位模型在系统设置配置：
 * - model_tier_economy（轻量档）：蜂群工蜂/辩手/平台 LLM 反思等高并发低难度调用
 * - model_tier_premium（高级档）：计划模式/验收/返工/裁决/蜂群请示等高质量调用
 * 标准档 = 不覆盖（沿用执行器档案模型），故无第三个设置键。空值 = 未配置不覆盖，零回归。
 */
import type { Task } from './task';
import type { DB } from '../db/client';
import { getSystemSettings } from './setting';

export type ModelTier = 'economy' | 'premium';

/** 判定任务的模型档位（纯函数；null = 标准，不覆盖）。 */
export function modelTierForTask(task: Task, assigneeRole?: string | null): ModelTier | null {
  const proto = (task.inputProtocol ?? {}) as Record<string, unknown>;
  const trigger = typeof proto.trigger === 'string' ? proto.trigger : '';
  const mode = typeof proto.mode === 'string' ? proto.mode : '';
  // 轻量档：高并发、单点难度低——蜂群工蜂、辩手（立论/互攻）
  if (trigger === 'swarm_bee' || trigger === 'debate_round') return 'economy';
  // 高级档：错不起的调用——计划模式、验收/返工、裁决、蜂群请示把关
  if (mode === 'plan') return 'premium';
  if (trigger === 'debate_verdict' || trigger === 'swarm_request') return 'premium';
  if (proto.acceptanceReview || proto.type === 'business_rework') return 'premium';
  if (assigneeRole === 'debate-judge') return 'premium';
  return null;
}

/** 档位 → 模型标识（未配置返回 null = 不覆盖，沿用执行器档案/默认模型）。 */
export function resolveModelForTier(db: DB, tier: ModelTier): string | null {
  const settings = getSystemSettings(db);
  const value = tier === 'economy' ? settings.modelTierEconomy : settings.modelTierPremium;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
