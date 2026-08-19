/**
 * 系统岗（指挥系统 W0 + 组织模型批次二）：养蜂人（蜂群，可见固定岗）+ 人事（专家供给，可见固定岗）
 * + 裁决法庭（对抗评审庭，隐形）。
 *
 * 产品语义：系统岗是工作台的"内置职能"——自动存在、不可删除；养蜂人/人事对用户可见可对话
 * （组织模型 2026-08-19 定案：四固定岗全可见），裁决法庭保持隐形（只在辩论被召集时出场）。
 * 蓝图组织批次4e：与公司生命周期解耦——首次使用时懒确保，任何状态下幂等自愈。
 * 注：按工作台实例化而非全局单例——任务必须属于项目、项目属于工作台，
 * 执行体必须同工作台（createTask 守卫）；工作台模型下按工作台实例化即为产品意义上的全局。
 */
import type { DB } from '../db/client';
import { createAgent } from './agent';
import { getWorkbench } from './workbench';
import { bindDefaultDenyPolicy } from './permission-templates';

export const DISPATCHER_ROLE = 'swarm-dispatcher';
export const JUDGE_ROLE = 'debate-judge';
export const HR_ROLE = 'hr';
export const DISPATCHER_NAME = '养蜂人';
export const JUDGE_NAME = '裁决法庭';
export const HR_NAME = '人事';

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
   指定 personaId 的蜂会优先复用项目专家池的常驻专家（同一专家跨任务延续记忆）；项目反复需要
   同一专长时系统会自动把它沉淀为项目专家。缺专家时可建议用户找「人事」专项设计。
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

const HR_PROMPT = `你是「${HR_NAME}」，工作台的专家供给岗。你不做具体业务工作，只负责专家的供给与分派建议。

职责：
1. 接到用人需求（来自用户、负责人或养蜂人）时：先看上下文提供的「专家池清单」——
   项目已有专家与全局常驻专家能覆盖的，直接建议复用（在 summary 里点名谁适合、为什么）。
2. 确实缺人时，返回 staffingPlan 建新专家：
   { "specialists": [{ "specialty": "专长描述", "personaId"?: "建议穿戴的人设 id（可选，从人设库索引选）", "brief": "这位专家的职责说明" }] }
   系统会为每位专家建立「项目专家」：常驻本项目、跨任务复用、只加不减，建好后出现在花名册即可派遣。
3. 拆解需求时想清楚流程再定人选：不把活拆碎（一个人的事不拆两个专家），也不让一个专家包打天下。
4. 用户自建人才（我的 talent）若在岗且匹配，优先建议使用，而不是新建。`;

function findSystemAgent(db: DB, role: string): string | null {
  const row = db
    .prepare('SELECT id FROM agent_definition WHERE role=? AND is_system=1 LIMIT 1')
    .get(role) as { id: string } | undefined;
  return row?.id ?? null;
}

function ensureOne(db: DB, role: string, name: string, prompt: string, options: { visible?: boolean } = {}): string {
  const existing = findSystemAgent(db, role);
  if (existing) {
    // 可见岗幂等自愈：老库里任职行可能还是 hidden=1（组织模型批次二之前的创建路径）
    if (options.visible) {
      db.prepare('UPDATE company_employee SET hidden=0 WHERE legacy_agent_id=? AND hidden=1').run(existing);
    }
    return existing;
  }
  const agent = createAgent(db, {
    name,
    role,
    responsibilities: options.visible ? '系统固定职能岗（专家供给/蜂群调度）' : '系统内置职能岗（自动创建，不可见）',
    systemPrompt: prompt,
    canDispatch: true,
    isSystem: true,
  });
  // 组织模型批次二：养蜂人/人事是可见固定岗——撤掉 isSystem 默认的 hidden 标记
  if (options.visible) {
    db.prepare('UPDATE company_employee SET hidden=0 WHERE legacy_agent_id=?').run(agent.id);
  }
  // R1：系统岗默认绑 deny 档——它们只产结构化文本（swarmPlan/debateVerdict/staffingPlan），
  // API 执行器上不再零拦截（与 CLI 侧 fail-closed 对齐）。
  bindDefaultDenyPolicy(db, agent.id);
  return agent.id;
}

export interface SystemAgents {
  dispatcherAgentId: string;
  judgeAgentId: string;
  hrAgentId: string;
}

/** 幂等确保系统岗存在（工作台任意状态可调用；coordinator tick 调用）。 */
export function ensureSystemAgents(db: DB): SystemAgents {
  getWorkbench(db);
  return {
    dispatcherAgentId: ensureDispatcherAgentId(db),
    judgeAgentId: ensureJudgeAgentId(db),
    hrAgentId: ensureHrAgentId(db),
  };
}

/** 查询系统岗 id（不存在返回 null，不创建）。 */
export function getDispatcherAgentId(db: DB): string | null {
  return findSystemAgent(db, DISPATCHER_ROLE);
}

export function getJudgeAgentId(db: DB): string | null {
  return findSystemAgent(db, JUDGE_ROLE);
}

export function getHrAgentId(db: DB): string | null {
  return findSystemAgent(db, HR_ROLE);
}

/** 蓝图组织批次4e：懒确保养蜂人（首次使用时创建，幂等；组织模型批次二起为可见固定岗）。 */
export function ensureDispatcherAgentId(db: DB): string {
  return ensureOne(db, DISPATCHER_ROLE, DISPATCHER_NAME, DISPATCHER_PROMPT, { visible: true });
}

/** 蓝图组织批次4e：懒确保裁决法庭（幂等，保持隐形）。 */
export function ensureJudgeAgentId(db: DB): string {
  return ensureOne(db, JUDGE_ROLE, JUDGE_NAME, JUDGE_PROMPT);
}

/** 组织模型批次二：懒确保人事岗（可见固定岗，专家供给）。 */
export function ensureHrAgentId(db: DB): string {
  return ensureOne(db, HR_ROLE, HR_NAME, HR_PROMPT, { visible: true });
}
