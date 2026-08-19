import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * R1：人设配枪——工具供给层 集成测试。
 *
 * 验证：
 * - 穿戴人设的任务上下文含「# 人设工具」文本段（注册表外工具兜底提示）。
 * - 未穿戴人设不出现人设工具段。
 * - normalizeToolId 归一化（人设声明 ↔ 注册表匹配的基础）。
 * - 临时工/系统隐形岗创建即绑定「临时工」deny 权限档（API 执行器不再零拦截）；
 *   已有显式策略不覆盖。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { createTempEmployment, convertTempToPermanent } from '../../src/server/domain/temp-worker';
import { ensureSystemAgents } from '../../src/server/domain/system-agents';
import { getEmployeePermissionPolicy } from '../../src/server/domain/permission';
import { bindDefaultDenyPolicy, ensureRolePermissionTemplates } from '../../src/server/domain/permission-templates';
import { normalizeToolId } from '../../src/server/domain/tool-recommendation';
import { assembleContext } from '../../src/server/executors/context';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

function seed() {
  const c = restoreWorkbench(db, { id: 'wb_fix_1', name: '公司' });
  const agent = createAgent(db, { companyId: c.id, name: '干员', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir: '/tmp/p', firstAgentId: agent.id, initialState: 'active',
  });
  return { c, agent, p };
}

function employmentId(agentId: string): string {
  return (db.prepare('SELECT id FROM company_employee WHERE legacy_agent_id=?').get(agentId) as { id: string }).id;
}

describe('persona 工具注入', () => {
  it('穿戴人设：上下文含「# 人设工具」文本段（注册表外工具也有兜底提示）', () => {
    const { agent, p } = seed();
    const task = createTask(db, {
      projectId: p.id, assigneeAgentId: agent.id, title: '写 PRD', personaId: 'product/product-manager',
    });
    const sp = assembleContext(db, task).systemPrompt;
    expect(sp).toContain('# 人设工具');
    expect(sp).toContain('WebFetch'); // product-manager.md frontmatter 声明的工具
  });

  it('未穿戴人设：无人设工具段', () => {
    const { agent, p } = seed();
    const task = createTask(db, { projectId: p.id, assigneeAgentId: agent.id, title: '普通任务' });
    const sp = assembleContext(db, task).systemPrompt;
    expect(sp).not.toContain('# 人设工具');
  });

  it('normalizeToolId：大小写/下划线/空格归一化为小写连字符（注册表匹配基础）', () => {
    expect(normalizeToolId('WebFetch')).toBe('webfetch');
    expect(normalizeToolId('whisper_api')).toBe('whisper-api');
    expect(normalizeToolId('  openpyxl ')).toBe('openpyxl');
  });
});

describe('一次性执行体 deny 权限绑定（R1）', () => {
  it('临时工创建即绑 deny 档', () => {
    const { c, agent } = seed();
    const { agentId } = createTempEmployment(db, {
      companyId: c.id, role: 'swarm-worker', requesterAgentId: agent.id, name: '工蜂-1',
    });
    const policy = getEmployeePermissionPolicy(db, employmentId(agentId));
    expect(policy).not.toBeNull();
    expect(policy!.approvalStrategy).toBe('deny');
  });

  it('系统隐形岗（养蜂人）创建即绑 deny 档', () => {
    const { c } = seed();
    const sys = ensureSystemAgents(db, c.id);
    const policy = getEmployeePermissionPolicy(db, employmentId(sys.dispatcherAgentId));
    expect(policy).not.toBeNull();
    expect(policy!.approvalStrategy).toBe('deny');
  });

  it('已有显式策略的临时工不被覆盖', () => {
    const { c, agent } = seed();
    const { agentId } = createTempEmployment(db, {
      companyId: c.id, role: '外包评审', requesterAgentId: agent.id, name: '评审临时工',
    });
    // 先显式绑一个非 deny 策略，再走绑定路径（模拟复用/二次确保）→ 不被覆盖
    const templates = ensureRolePermissionTemplates(db);
    db.prepare('UPDATE company_employee SET permission_policy_id=? WHERE id=?').run(
      templates.manager, employmentId(agentId),
    );
    bindDefaultDenyPolicy(db, agentId);
    expect(getEmployeePermissionPolicy(db, employmentId(agentId))!.approvalStrategy).toBe('no-approval');
  });

  it('Review 修复 I4：临时工转正时 deny 档自动重绑为员工档（ask-by-rule）', () => {
    const { c, agent } = seed();
    const { agentId } = createTempEmployment(db, {
      companyId: c.id, role: '外援专家', requesterAgentId: agent.id, name: '外援一号',
    });
    expect(getEmployeePermissionPolicy(db, employmentId(agentId))!.approvalStrategy).toBe('deny');
    convertTempToPermanent(db, agentId);
    const policy = getEmployeePermissionPolicy(db, employmentId(agentId));
    expect(policy!.approvalStrategy).toBe('ask-by-rule');
    expect(policy!.scope).toBe('task');
  });
});
