/**
 * 三档广深（B2）：任务级上限档位——只限"最多派多少人/拆多细/验几轮"，不管用什么模型。
 *
 * 设计约束（定版）：
 * - 档位是天花板不是定额：组内（养蜂人/人事/执行者）在帽内自决用满与否——轻任务拆三只小蜂仍是轻任务。
 * - 与模型档位（model-tier.ts 的 ExecutorTier）两维正交，互不绑定——"轻广深+高模型"（重思考轻执行）合法。
 * - 全局设置仍是平台天花板：蜂群三限取 min(全局, 档位)；预算（金额）不归档位管，沿用全局。
 * - 任务形态不预设：写文章要不要调研/润色由负责人读意图决定，档位只封顶不指路。
 */
import type { DB } from '../db/client';
import { getSystemSettings } from './setting';

export type BreadthTier = 'light' | 'standard' | 'heavy';

export interface BreadthLimits {
  tier: BreadthTier;
  /** 蓝图班组总槽位上限（含主槽）：轻=只主、中=2-3、重=满配 4。 */
  crewSlots: number;
  /** 蜂群下探深度上限（与全局取 min）。 */
  swarmMaxDepth: number;
  /** 蜂群单层扇出宽度上限（与全局取 min）。 */
  swarmMaxWidth: number;
  /** 蜂群单群节点上限（与全局取 min）。 */
  swarmMaxNodes: number;
  /** 验收→返工轮次上限（超限升级用户）。 */
  acceptanceReworkRounds: number;
  /** 讨论发言轮次默认上限（聊完即收，不为走满轮次）。 */
  discussionMaxTurns: number;
}

/** 三档常量表（定版：轻 1槽/1·3·4/1轮/6轮；中 3槽/2·5·12/2轮/12轮；重 4槽/3·8·30/3轮/20轮）。 */
export const BREADTH_LIMITS: Record<BreadthTier, Omit<BreadthLimits, 'tier'>> = {
  light: { crewSlots: 1, swarmMaxDepth: 1, swarmMaxWidth: 3, swarmMaxNodes: 4, acceptanceReworkRounds: 1, discussionMaxTurns: 6 },
  standard: { crewSlots: 3, swarmMaxDepth: 2, swarmMaxWidth: 5, swarmMaxNodes: 12, acceptanceReworkRounds: 2, discussionMaxTurns: 12 },
  heavy: { crewSlots: 4, swarmMaxDepth: 3, swarmMaxWidth: 8, swarmMaxNodes: 30, acceptanceReworkRounds: 3, discussionMaxTurns: 20 },
};

export function isBreadthTier(value: unknown): value is BreadthTier {
  return value === 'light' || value === 'standard' || value === 'heavy';
}

/** 任务级档位：inputProtocol.breadthTier ?? 工作台默认档（系统设置，默认 standard）。 */
export function taskBreadthTier(db: DB, proto: Record<string, unknown> | undefined | null): BreadthTier {
  if (proto && isBreadthTier(proto.breadthTier)) return proto.breadthTier;
  return getSystemSettings(db).breadthDefaultTier;
}

export function breadthLimits(tier: BreadthTier): BreadthLimits {
  return { tier, ...BREADTH_LIMITS[tier] };
}

/**
 * 蜂群三限档位钳制：min(基础限额, 档位上限)。基础限额来自全局设置或专家自主额度（limitsOverride），
 * 预算不钳（金额属平台财务域，档位不管钱）。materializeSwarm 建群快照前调用。
 */
export function clampSwarmLimits(
  base: { maxDepth: number; maxWidth: number; maxNodes: number; budgetUsd: number },
  tier: BreadthTier,
): { maxDepth: number; maxWidth: number; maxNodes: number; budgetUsd: number } {
  const cap = BREADTH_LIMITS[tier];
  return {
    maxDepth: Math.min(base.maxDepth, cap.swarmMaxDepth),
    maxWidth: Math.min(base.maxWidth, cap.swarmMaxWidth),
    maxNodes: Math.min(base.maxNodes, cap.swarmMaxNodes),
    budgetUsd: base.budgetUsd,
  };
}
