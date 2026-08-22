/**
 * 系统岗（B5 中央六岗制）：养蜂人（蜂群）+ 人事（专家供给）+ 能力管理（装备供给）
 * + 裁决法庭（对抗评审）全部隐形（visible_in='central'）；验收员同制（acceptance-officer.ts）。
 *
 * 产品语义：一个人就是一个公司——用户只对负责人说话，中央职能经负责人传达，
 * 靠反思沉淀自动进化；"事"在右侧状态卡可见（专家池/蜂群/验收进度），
 * "人"经 visible_in='central' 口子可被 @（GET /api/agents?visible_in=central）。
 * 蓝图组织批次4e：与生命周期解耦——首次使用时懒确保，任何状态下幂等自愈。
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
export const CAPABILITY_ROLE = 'capability-manager';
export const DISPATCHER_NAME = '养蜂人';
export const JUDGE_NAME = '裁决法庭';
export const HR_NAME = '人事';
/** H9b：安全审查员（隐形中央岗——AI 审批判定的组织身份；判定留档 permission_audit 可追责）。 */
export const SECURITY_REVIEWER_ROLE = 'security-reviewer';
export const SECURITY_REVIEWER_NAME = '安全审查员';
export const CAPABILITY_MANAGER_NAME = '能力管理';

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
   同一专长时系统会自动把它沉淀为项目专家。缺专家时向负责人建议由「人事」专项设计（经负责人传达，用户只对负责人说话）。
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

const CAPABILITY_PROMPT = `你是「${CAPABILITY_MANAGER_NAME}」，工作台的装备供给岗（隐形职能，服务执行者不面向用户）。你不做具体业务工作，只负责工具/能力的准备、建议与链接。

职责：
1. 收到「[装备请示]」任务时（某执行者缺某能力/工具用不了）：分析缺口，产出结构化建议——
   summary 按契约返回：
   GAP=<能力 id>
   SUGGEST=<建议方案：用哪个已启用工具替代 / 建议安装什么（tool_registry 或商城条目 id）/ 自建插件方向>
   RATIONALE=<一段理由：为什么这个方案适合该任务形态>
2. 纪律：只产建议，绝不自行安装或修改配置——安装与配置变更走平台能力中心/商城（用户确认后生效）；
   注册表内已有可用替代时优先建议替代，缺什么说什么，不编造工具 id。
3. 常用工具已由系统自动携带（默认套装+使用频次），你只处理缺口与质量差（成功率低建议换用）两类请示。`;

function findSystemAgent(db: DB, role: string): string | null {
  const row = db
    .prepare('SELECT id FROM agent_definition WHERE role=? AND is_system=1 LIMIT 1')
    .get(role) as { id: string } | undefined;
  return row?.id ?? null;
}

function ensureOne(db: DB, role: string, name: string, prompt: string, options: { visibleIn?: string } = {}): string {
  const existing = findSystemAgent(db, role);
  if (existing) {
    // B5 中央岗分区幂等自愈：老库 visible_in 缺失时补上（hidden 不在此翻——迁移负责存量）
    if (options.visibleIn) {
      db.prepare('UPDATE agent_definition SET visible_in=? WHERE id=? AND (visible_in IS NULL OR visible_in != ?)')
        .run(options.visibleIn, existing, options.visibleIn);
    }
    return existing;
  }
  const agent = createAgent(db, {
    name,
    role,
    responsibilities: '系统内置职能岗（自动创建，隐形——事在右侧状态卡可见）',
    systemPrompt: prompt,
    canDispatch: true,
    isSystem: true,
  });
  // B5：中央职能全隐形（isSystem 默认 hidden），分区标记供 @ 下拉/群聊专用口子取数
  if (options.visibleIn) {
    db.prepare('UPDATE agent_definition SET visible_in=? WHERE id=?').run(options.visibleIn, agent.id);
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

/** 幂等确保系统岗存在（工作台任意状态可调用；coordinator tick 调用）；确保后种中央互通白名单。 */
export function ensureSystemAgents(db: DB): SystemAgents {
  getWorkbench(db);
  const ids = {
    dispatcherAgentId: ensureDispatcherAgentId(db),
    judgeAgentId: ensureJudgeAgentId(db),
    hrAgentId: ensureHrAgentId(db),
  };
  ensureCentralContactAllow(db);
  return ids;
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

export function getCapabilityManagerAgentId(db: DB): string | null {
  return findSystemAgent(db, CAPABILITY_ROLE);
}

/** B5：懒确保养蜂人（隐形中央岗——蜂群状态在右侧卡可见；@ 走 visible_in=central 口子）。 */
export function ensureDispatcherAgentId(db: DB): string {
  return ensureOne(db, DISPATCHER_ROLE, DISPATCHER_NAME, DISPATCHER_PROMPT, { visibleIn: 'central' });
}

/** B5：懒确保裁决法庭（隐形中央岗，只在辩论被召集时出场；群聊常驻可被 @）。 */
export function ensureJudgeAgentId(db: DB): string {
  return ensureOne(db, JUDGE_ROLE, JUDGE_NAME, JUDGE_PROMPT, { visibleIn: 'central' });
}

/** 整改计划 Part2：自动化管家——平台自动化功能的固定岗，仅在自动化页可见（任职 hidden，visible_in='automation'）。 */
export const AUTOMATION_ROLE = 'automation-steward';
export const AUTOMATION_STEWARD_NAME = '自动化管家';

/** 懒确保自动化管家（幂等）：任职保持 hidden（正常花名册不可见），visible_in 标记自动化页归属。 */
export function ensureAutomationStewardAgentId(db: DB): string {
  return ensureOne(db, AUTOMATION_ROLE, AUTOMATION_STEWARD_NAME, '', { visibleIn: 'automation' });
}

/** H9b：懒确保安全审查员岗（隐形中央岗——权限判定的组织身份锚点，供追责/点名）。 */
export function ensureSecurityReviewerAgentId(db: DB): string {
  return ensureOne(db, SECURITY_REVIEWER_ROLE, SECURITY_REVIEWER_NAME, SECURITY_REVIEWER_PROMPT, { visibleIn: 'central' });
}

const SECURITY_REVIEWER_PROMPT = `你是 muster 的安全审查员。每次判定输入一条命令/文件操作，输出四级递进安全评估。
准绳：不可逆/凭据/系统/部署类一律 unsafe；只读类通常 company_scope 以上；工作区内写通常 project_scope。
你的每次判定都留档可追责（permission_audit），拿不准就 uncertain 转人工，不猜测放行。`;

/** B5：懒确保人事岗（隐形中央岗——专家池状态在右侧卡可见；需求经负责人传达）。 */
export function ensureHrAgentId(db: DB): string {
  return ensureOne(db, HR_ROLE, HR_NAME, HR_PROMPT, { visibleIn: 'central' });
}

/** B3 能力管理：懒确保装备供给岗（隐形——服务执行者不面向用户；热路径决议为纯代码，此岗只接冷路径请示）。 */
export function ensureCapabilityManagerAgentId(db: DB): string {
  return ensureOne(db, CAPABILITY_ROLE, CAPABILITY_MANAGER_NAME, CAPABILITY_PROMPT, { visibleIn: 'central' });
}

/** B5 中央岗角色集（白名单：讨论双闸/@ 下拉/群聊候选）。 */
export const CENTRAL_STAFF_ROLES = [
  'swarm-dispatcher',
  'hr',
  'capability-manager',
  'acceptance-officer',
  'debate-judge',
] as const;

/**
 * B5 中央六岗互通：隐形后非系统隐藏体（验收员非 isSystem）会被 crewMate 派发守卫排除——
 * 中央岗 + 负责人互写 contactAllow 种子（幂等，只增不减；验收员可能尚未懒确保，存在才互通）。
 */
export function ensureCentralContactAllow(db: DB): void {
  try {
    const wb = getWorkbench(db);
    const centralIds = [
      getDispatcherAgentId(db),
      getJudgeAgentId(db),
      getHrAgentId(db),
      getCapabilityManagerAgentId(db),
      (() => {
        const row = db.prepare("SELECT id FROM agent_definition WHERE role='acceptance-officer' AND is_inspector=1 LIMIT 1")
          .get() as { id: string } | undefined;
        return row?.id ?? null;
      })(),
    ].filter((x): x is string => Boolean(x));
    // 负责人取工作台 + 项目两级并集（负责人常只配在项目级，workbench.firstAgentId 可能为空）
    const leadIds = new Set<string>();
    if (wb.firstAgentId) leadIds.add(wb.firstAgentId);
    for (const row of db.prepare('SELECT DISTINCT first_agent_id AS f FROM project WHERE first_agent_id IS NOT NULL').all() as Array<{ f: string }>) {
      leadIds.add(row.f);
    }
    const members = [...centralIds, ...leadIds];
    if (members.length < 2) return;
    const now = new Date().toISOString();
    for (const id of members) {
      const row = db.prepare('SELECT contact_allow_json FROM agent_definition WHERE id=?').get(id) as
        | { contact_allow_json: string }
        | undefined;
      if (!row) continue;
      const cur = JSON.parse(row.contact_allow_json ?? '[]') as string[];
      const next = [...new Set([...cur.filter((x) => typeof x === 'string'), ...members.filter((m) => m !== id)])];
      if (next.length !== cur.length) {
        db.prepare('UPDATE agent_definition SET contact_allow_json=?, updated_at=? WHERE id=?')
          .run(JSON.stringify(next), now, id);
      }
    }
  } catch {
    /* 种子失败不阻断（下次 ensure 自愈） */
  }
}
