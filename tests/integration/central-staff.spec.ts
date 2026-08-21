/**
 * B5 中央六岗制 集成测试。
 *
 * 验证：
 * - 隐形：人事/养蜂人/验收员 hidden=1 花名册不可见；负责人保持可见（用户唯一对话入口）。
 * - 分区口子：GET listAgents({visibleIn:'central'}) 取六岗（hidden 不影响）。
 * - 互通种子：ensureCentralContactAllow 幂等互写 contactAllow（验收员非 isSystem，靠种子保持可派发）。
 * - @负责人 关键词扇出：postUserMessage 的 mentions 含关键词 → 展开为全部 lead 岗。
 * - 观测：listAgents({includeHidden}) 含隐形中央岗（报表/备份/驾驶舱口径）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent, getAgent, listAgents } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { ensureSystemAgents, ensureCentralContactAllow, CENTRAL_STAFF_ROLES } from '../../src/server/domain/system-agents';
import { ensureAcceptanceOfficer } from '../../src/server/domain/acceptance-officer';
import { postUserMessage, listMessages } from '../../src/server/domain/conversation';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

function seed() {
  const c = restoreWorkbench(db, { id: 'wb_central_1', name: '公司' });
  const lead = createAgent(db, { companyId: c.id, name: '干员', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir: '/tmp/central', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

describe('中央六岗隐形 + 分区口子', () => {
  it('养蜂人/人事/裁决庭/能力管理/验收员全隐形；负责人可见；central 口子取六岗', () => {
    const { c, lead } = seed();
    const sys = ensureSystemAgents(db);
    const officerId = ensureAcceptanceOfficer(db);

    const visible = listAgents(db);
    expect(visible.some((a) => a.id === lead.id)).toBe(true); // 负责人 = 用户唯一入口，保持可见
    for (const id of [sys.dispatcherAgentId, sys.judgeAgentId, sys.hrAgentId, officerId]) {
      expect(visible.some((a) => a.id === id)).toBe(false); // 隐形：花名册不出现
    }
    const central = listAgents(db, { visibleIn: 'central' });
    for (const id of [sys.dispatcherAgentId, sys.judgeAgentId, sys.hrAgentId, officerId]) {
      expect(central.some((a) => a.id === id)).toBe(true); // 口子可取
    }
    // includeHidden 含全部（报表/备份/驾驶舱口径）
    const all = listAgents(db, { includeHidden: true });
    for (const id of [sys.dispatcherAgentId, sys.judgeAgentId, sys.hrAgentId, officerId]) {
      expect(all.some((a) => a.id === id)).toBe(true);
    }
    // 角色集契约
    expect((CENTRAL_STAFF_ROLES as readonly string[]).includes('acceptance-officer')).toBe(true);
    void c;
  });
});

describe('中央互通种子（contactAllow）', () => {
  it('幂等互写：验收员与负责人互在 contactAllow；重复调用不膨胀', () => {
    const { c, lead } = seed();
    const sys = ensureSystemAgents(db);
    const officerId = ensureAcceptanceOfficer(db);
    ensureCentralContactAllow(db);
    ensureCentralContactAllow(db); // 幂等

    const officer = getAgent(db, officerId);
    expect(officer.contactAllow).toContain(lead.id);
    expect(officer.contactAllow).toContain(sys.dispatcherAgentId);
    const leadAgent = getAgent(db, lead.id);
    expect(leadAgent.contactAllow).toContain(officerId);
    // 不膨胀：去重后数量固定
    const unique = new Set(officer.contactAllow);
    expect(officer.contactAllow.length).toBe(unique.size);
    void c;
  });
});

describe('@负责人 关键词扇出', () => {
  it('mentions 含「@负责人」→ 展开为 lead 岗建任务；意图锚点随用户消息任务落（B3）', () => {
    const { c, lead, p } = seed();
    const result = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: p.id,
      content: '这个任务请优先处理',
      mentions: ['@负责人'],
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.assigneeAgentId).toBe(lead.id);
    // 意图锚点随用户消息任务落（B3）
    expect((result.tasks[0]!.inputProtocol as Record<string, unknown>).intentAnchor).toMatchObject({
      goal: '这个任务请优先处理',
    });
    const msgs = listMessages(db, 'project', p.id, undefined);
    expect(msgs.length).toBeGreaterThan(0);
    void c;
  });
});
