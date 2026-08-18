/**
 * R2：验收员——工作台收尾验收岗（固定可见员工）。
 *
 * 定位：开始（项目准备/对齐）→ 经过（执行/发布）→ 收尾（对照计划验收）→ 交付。
 * 验收的对照物 = 任务验收标准（acceptanceCriteria，用户需求的可检验形态）。
 *
 * 与系统隐形岗（调度中心/评审中心）的区别：验收员是**可见正式员工**——
 * 花名册可见、可对话、可 @；默认自动做验收，用户没要求就自动，
 * 有要求（换人/跳过/追问意见）随时可对话调整。is_inspector=true 保证固定（不可删除）。
 */
import type { DB } from '../db/client';
import { createAgent } from './agent';
import { getWorkbench } from './workbench';
import { getRoleTemplate } from './permission-templates';
import { bindEmployeePermissionPolicy } from './permission';

export const ACCEPTANCE_OFFICER_ROLE = 'acceptance-officer';
export const ACCEPTANCE_OFFICER_NAME = '验收员';

const ACCEPTANCE_PROMPT = `你是「${ACCEPTANCE_OFFICER_NAME}」，工作台的收尾验收岗。你不生产成果，只负责对照计划验收。

职责：
1. 收到「[验收]」任务时：对照任务验收标准（acceptanceCriteria，含产出者自评 met 标记）与产物清单、任务摘要，
   独立判定本次交付是否达标。只看标准与事实，不持立场、不拉偏架。
2. 判定输出（完成时按输出契约返回）：
   VERDICT=PASS  （全部达标，可交付）
   VERDICT=FAIL  （核心标准未达标，应返工）
   VERDICT=CHANGES（部分达标/需调整后交付）
   CONFIDENCE=0~1（对判定的把握；拿不准就给低置信，低置信会转交用户拍板——这不是失败）
   随后一行给具体 feedback：指出未达标条款与理由，给返工可执行的修改方向。
3. 纪律：区分"风格差异"与"实质缺陷"；产物缺失/未发布时按未达标处理；不确定时诚实低置信，不要硬判。`;

/**
 * 幂等懒确保验收员（可见正式员工）：
 * - is_inspector=true（固定岗，不可删除）
 * - 绑「经理」权限档（project scope no-approval，高危动作仍拦截；验收要读产物对照标准）
 * - 执行器走三级默认路由（不绑固定档案，继承工作台默认）
 * - userDirectContact 默认开（可对话）
 */
export function ensureAcceptanceOfficer(db: DB): string {
  getWorkbench(db);
  const existing = db
    .prepare('SELECT id FROM agent_definition WHERE role=? AND is_inspector=1 LIMIT 1')
    .get(ACCEPTANCE_OFFICER_ROLE) as { id: string } | undefined;
  if (existing) return existing.id;

  const agent = createAgent(db, {
    name: ACCEPTANCE_OFFICER_NAME,
    role: ACCEPTANCE_OFFICER_ROLE,
    responsibilities: '收尾验收：对照验收标准独立判定成果是否可交付；默认自动验收，用户可对话调整。',
    systemPrompt: ACCEPTANCE_PROMPT,
    canDispatch: true,
    isInspector: true,
    permissions: { userDirectContact: true },
    // Review 修复 C1：验收员懒确保发生在任务完成时——工作台通常 online，
    // 必须豁免 org lock（internalRecruit：豁免但不 hidden，保持可见员工语义）。
    internalRecruit: true,
  });
  // 经理档（skipLock：与懒确保语义一致，工作台运行中也能自愈创建）
  try {
    const employment = db
      .prepare('SELECT id FROM company_employee WHERE legacy_agent_id=?')
      .get(agent.id) as { id: string } | undefined;
    if (employment) {
      bindEmployeePermissionPolicy(db, employment.id, getRoleTemplate(db, 'manager').id, { skipLock: true });
    }
  } catch {
    // 绑定失败不阻断验收员创建（CLI 侧 fail-closed 兜底）
  }
  return agent.id;
}
