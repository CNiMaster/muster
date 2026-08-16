/**
 * 系统隐形岗（指挥系统 W0）：调度中心（蜂群）+ 评审中心（对抗评审庭）。
 *
 * 产品语义：它们是工作台的"内置职能"而不是员工——自动存在、不出现在花名册、用户不可控。
 * 蓝图组织批次4e：与公司生命周期解耦——创建不再依赖"公司上线"时机（coordinator tick），
 * 改为**首次使用时懒确保**（context 装配 / 辩论开庭 / 蜂群收口），任何状态下幂等自愈。
 * 注：按工作台实例化而非全局单例——任务必须属于项目、项目属于工作台，
 * 执行体必须同工作台（createTask 守卫）；工作台模型下按工作台实例化即为产品意义上的全局。
 */
import type { DB } from '../db/client';
import { createAgent } from './agent';
import { getCompany } from './company';
import { bindDefaultDenyPolicy } from './permission-templates';

export const DISPATCHER_ROLE = 'swarm-dispatcher';
export const JUDGE_ROLE = 'debate-judge';
export const DISPATCHER_NAME = '调度中心';
export const JUDGE_NAME = '评审中心';

const DISPATCHER_PROMPT = `你是「${DISPATCHER_NAME}」，公司的大规模并行工作指挥岗。你不做具体工作，只负责拆解、调度、收口。

职责：
1. 接到"组织蜂群/大规模并行"类任务时，先判断目标是否适合并行拆解：
   - 适合：可分成互相独立的小单元、需要广度覆盖的工作（大范围调研、信息扫描、多方案评估、批量检查）。
   - 不适合：紧耦合的构建类工作（每步依赖上一步结果）——直接说明原因并给出替代建议，不要硬拆。
2. 适合拆解时：按需拆成尽量少的工蜂任务（够用就好，不要为凑数多拆；每只蜂一个独立子题），
   在最终结果中返回 swarmPlan：{ "goal": "总目标", "workers": [{ "title": "子题", "brief": "给这只蜂的具体指令与边界", "personaId"?: "子题要求的专家人设 id" }] }，
   outcome 用 waiting_dependency。系统会为每只蜂创建一次性工蜂并等待全部完成。
3. 三种蜂型（按目标性质选用）：
   - 匿名蜂群：广度覆盖的简单扫描（不指定 personaId，工蜂匿名执行）。
   - 同种专家蜂群：同一类专业判断需要多路并行（全部 worker 给同一 personaId，如批量调研）。
   - 混合专家蜂群：一个目标需要多种专业配合（不同 worker 给不同 personaId，如 调研+分析+写作 各一只）。
   人设 id 可在你的上下文中按子题主题检索（persona 库与记忆）；拿不准就匿名，不要硬编。
4. 收到「[蜂群告警]」任务时（有蜂失败）：评估后三选一——
   a) 补蜂：返回新的 swarmPlan（只含需要补做的子题）；
   b) 缩群：直接完成汇报，说明用现有结果收口；
   c) 放弃：说明为什么目标不可达，返回 blocked。
5. 收到「[蜂群汇总]」任务时：聚合各蜂的结构化摘要，产出收口报告——
   结论 / 分歧点 / 关键证据（带来源）/ 遗留风险与建议。承认信息缺失，不编造。`;

const JUDGE_PROMPT = `你是「${JUDGE_NAME}」，公司的决策评审岗。你主持对抗式评审（辩论），自己不持立场。

职责：
1. 收到辩论任务时：你只做裁决。辩手（正方/反方）的立论与互攻材料会作为输入提供。
2. 裁决输出：推荐选项（或"都不推荐"）、每个选项的致命缺点（最坏会发生什么、能否接受）、置信度（0~1）、理由。
3. 纪律：不拉偏架；优先采信指出致命伤且未被有效回应的论证；区分"风格差异"与"实质缺陷"；
   双方都说不清时坦率给低置信度——低置信度会转交用户决策，这不是失败。
4. 汇总偏好：若输入包含用户历史决策记录，尊重其体现的偏好方向。`;

function findSystemAgent(db: DB, companyId: string, role: string): string | null {
  const row = db
    .prepare('SELECT id FROM agent_definition WHERE company_id=? AND role=? AND is_system=1 LIMIT 1')
    .get(companyId, role) as { id: string } | undefined;
  return row?.id ?? null;
}

function ensureOne(db: DB, companyId: string, role: string, name: string, prompt: string): string {
  const existing = findSystemAgent(db, companyId, role);
  if (existing) return existing;
  const agent = createAgent(db, {
    companyId,
    name,
    role,
    responsibilities: '系统内置职能岗（自动创建，不可见）',
    systemPrompt: prompt,
    canDispatch: true,
    isSystem: true,
  });
  // R1：系统隐形岗默认绑 deny 档——它们只产结构化文本（swarmPlan/debateVerdict），
  // API 执行器上不再零拦截（与 CLI 侧 fail-closed 对齐）。
  bindDefaultDenyPolicy(db, agent.id);
  return agent.id;
}

export interface SystemAgents {
  dispatcherAgentId: string;
  judgeAgentId: string;
}

/** 幂等确保系统隐形岗存在（公司任意状态可调用；coordinator tick 对 online 公司调用）。 */
export function ensureSystemAgents(db: DB, companyId: string): SystemAgents {
  getCompany(db, companyId);
  return {
    dispatcherAgentId: ensureOne(db, companyId, DISPATCHER_ROLE, DISPATCHER_NAME, DISPATCHER_PROMPT),
    judgeAgentId: ensureOne(db, companyId, JUDGE_ROLE, JUDGE_NAME, JUDGE_PROMPT),
  };
}

/** 查询系统岗 id（不存在返回 null，不创建）。 */
export function getDispatcherAgentId(db: DB, companyId: string): string | null {
  return findSystemAgent(db, companyId, DISPATCHER_ROLE);
}

export function getJudgeAgentId(db: DB, companyId: string): string | null {
  return findSystemAgent(db, companyId, JUDGE_ROLE);
}

/** 蓝图组织批次4e：懒确保调度中心（首次使用时创建，幂等；与公司上线时机解耦）。 */
export function ensureDispatcherAgentId(db: DB, companyId: string): string {
  return ensureOne(db, companyId, DISPATCHER_ROLE, DISPATCHER_NAME, DISPATCHER_PROMPT);
}

/** 蓝图组织批次4e：懒确保评审中心（幂等）。 */
export function ensureJudgeAgentId(db: DB, companyId: string): string {
  return ensureOne(db, companyId, JUDGE_ROLE, JUDGE_NAME, JUDGE_PROMPT);
}
