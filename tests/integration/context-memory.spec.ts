import { restoreWorkbench } from '../../src/server/domain/workbench';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
;
import { createMemoryCandidate, loadContextMemories, preservePersonaCraftMemories } from '../../src/server/domain/memory';
import { ensurePersonaArchiveProfile } from '../../src/server/domain/agent-profile';
import { addTaskMessage } from '../../src/server/domain/task-message';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { assembleContext } from '../../src/server/executors/context';
import { makeTestDb } from './setup';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

describe('execution context from profile and layered memory', () => {
  it('session 丢失时仍按身份、任职、项目、记忆顺序重建', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_1', name: '公司', charter: '公司章程内容' });
    const agent = createAgent(db, {
      companyId: company.id, name: '员工', role: 'architect', responsibilities: '负责架构', systemPrompt: '稳定身份：谨慎验证',
    });
    const project = createProject(db, { companyId: company.id, name: '项目', description: '项目目标内容' });
    const thread = ensurePrimaryThread(db, project.id, agent.id);
    createMemoryCandidate(db, {
      profileId: agent.profileId, scope: 'project', companyId: company.id, projectId: project.id,
      content: '当前项目决定采用事件驱动架构', author: 'user', confidence: 1, canInfluence: true, allowAutoApprove: true,
    });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '继续实现事件模块' });

    const context = assembleContext(db, task, { threadId: thread.id });

    expect(context.systemPrompt.indexOf('# 员工身份')).toBeLessThan(context.systemPrompt.indexOf('# 工作台章程'));
    expect(context.systemPrompt.indexOf('# 工作台章程')).toBeLessThan(context.systemPrompt.indexOf('# 项目说明'));
    expect(context.systemPrompt).toContain('稳定身份：谨慎验证');
    expect(context.systemPrompt).toContain('当前项目决定采用事件驱动架构');
  });

  it('共享同一执行器的两个 Profile 能读到彼此沉淀的用户偏好（定案 #8：偏好属于用户不属于员工）', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_2', name: '公司' });
    const first = createAgent(db, { companyId: company.id, name: '甲', role: 'engineer', executor: { provider: 'claude-cli' } });
    const second = createAgent(db, { companyId: company.id, name: '乙', role: 'engineer', executor: { provider: 'claude-cli' } });
    const project = createProject(db, { companyId: company.id, name: '项目' });
    createMemoryCandidate(db, {
      profileId: first.profileId, scope: 'personal', content: '甲的私有偏好：只用蓝色', author: 'user', confidence: 1,
      canInfluence: true, allowAutoApprove: true,
    });
    createMemoryCandidate(db, {
      profileId: second.profileId, scope: 'personal', content: '乙的私有偏好：只用绿色', author: 'user', confidence: 1,
      canInfluence: true, allowAutoApprove: true,
    });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: first.id, title: '选择界面颜色' });

    const context = assembleContext(db, task);

    expect(context.systemPrompt).toContain('甲的私有偏好');
    // 修复轮（批次 F）：personal=用户偏好全局可见——乙沉淀的偏好同样注入甲的上下文
    expect(context.systemPrompt).toContain('乙的私有偏好');
  });
});

describe('人设方法论（skill+persona_key）全局召回与蜂群沉淀边界', () => {
  it('CRAFT 挂人设档案宿主：任何穿戴同款人设的执行体都能读到，不穿戴/他人通用手艺不可见', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_3', name: '公司' });
    const wearer = createAgent(db, { companyId: company.id, name: '甲', role: 'engineer' });
    const other = createAgent(db, { companyId: company.id, name: '乙', role: 'engineer' });
    const project = createProject(db, { companyId: company.id, name: '项目' });
    const carrier = ensurePersonaArchiveProfile(db);
    // 专家蜂沉淀的 CRAFT：挂在人设档案宿主（迁移后的形态）
    createMemoryCandidate(db, {
      profileId: carrier, scope: 'skill', personaKey: 'qa/performance',
      content: '压测前先确认基线机器规格', author: 'agent', confidence: 1, canInfluence: true, allowAutoApprove: true,
    });
    // 乙的通用技能手艺（persona_key 为空）——不随人设外泄
    createMemoryCandidate(db, {
      profileId: other.profileId, scope: 'skill',
      content: '乙的私藏手艺：用 awk 批量改配置', author: 'agent', confidence: 1, canInfluence: true, allowAutoApprove: true,
    });

    const withPersona = createTask(db, { projectId: project.id, assigneeAgentId: wearer.id, title: '做压测', personaId: 'qa/performance' });
    const ctxOn = assembleContext(db, withPersona);
    expect(ctxOn.systemPrompt).toContain('压测前先确认基线机器规格');
    expect(ctxOn.systemPrompt).not.toContain('乙的私藏手艺');

    const withoutPersona = createTask(db, { projectId: project.id, assigneeAgentId: wearer.id, title: '做压测' });
    const ctxOff = assembleContext(db, withoutPersona);
    expect(ctxOff.systemPrompt).not.toContain('压测前先确认基线机器规格');
  });

  it('preservePersonaCraftMemories：临时 profile 的人设方法论迁到宿主，其余记忆不动', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_4', name: '公司' });
    const bee = createAgent(db, { companyId: company.id, name: '工蜂', role: 'engineer' });
    const survivor = createAgent(db, { companyId: company.id, name: '继任者', role: 'engineer' });
    const project = createProject(db, { companyId: company.id, name: '项目' });
    createMemoryCandidate(db, {
      profileId: bee.profileId, scope: 'skill', personaKey: 'product/pm',
      content: '写 PRD 先核对数据口径', author: 'agent', confidence: 1, canInfluence: true, allowAutoApprove: true,
    });
    createMemoryCandidate(db, {
      profileId: bee.profileId, scope: 'project', projectId: project.id,
      content: '本项目的私有经验：接口风格用 REST', author: 'agent', confidence: 1, canInfluence: true, allowAutoApprove: true,
    });

    const moved = preservePersonaCraftMemories(db, bee.profileId);
    expect(moved).toBeGreaterThanOrEqual(1);

    // 继任者穿戴同款人设 → 读到迁移后的方法论；项目记忆仍属原 profile 不外泄
    const recalled = loadContextMemories(db, { profileId: survivor.profileId, projectId: project.id, personaKey: 'product/pm' });
    expect(recalled.some((m) => m.content.includes('写 PRD 先核对数据口径'))).toBe(true);
    expect(recalled.some((m) => m.content.includes('接口风格用 REST'))).toBe(false);
    const carrierOwned = db.prepare(
      `SELECT COUNT(*) AS c FROM memory_entry WHERE profile_id=? AND scope='skill' AND persona_key='product/pm'`,
    ).get(ensurePersonaArchiveProfile(db)) as { c: number };
    expect(carrierOwned.c).toBeGreaterThanOrEqual(1);
  });

  it('蜂群汇总任务：蜂数超过 6 时所有蜂汇报仍进入上下文（扩窗）', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_5', name: '公司' });
    const dispatcher = createAgent(db, { companyId: company.id, name: '调度', role: 'dispatcher' });
    const project = createProject(db, { companyId: company.id, name: '项目' });
    const synthesis = createTask(db, {
      projectId: project.id,
      assigneeAgentId: dispatcher.id,
      title: '[蜂群汇总] 调研',
      inputProtocol: { swarmSynthesis: true, swarm: { swarmId: 'sw_1', goal: '调研', beeCount: 10 } },
    });
    for (let i = 1; i <= 10; i++) {
      addTaskMessage(db, synthesis.id, {
        author: 'system', role: 'dispatch',
        content: `[蜂成员汇报] Task #${i}「子题${i}」：结论${i}`,
      });
    }

    const ctx = assembleContext(db, synthesis);
    const discussion = JSON.stringify(ctx.inputPacket.recentDiscussion);
    expect(discussion).toContain('结论1'); // 最早的汇报不再被 6 条窗口挤掉
    expect(discussion).toContain('结论10');
  });
});
