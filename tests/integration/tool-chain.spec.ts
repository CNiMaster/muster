/**
 * B3 能力管理 集成测试。
 *
 * 验证：
 * - resolveToolChain 热路径：快照持久化 inputProtocol.resolvedToolChain + tool_chain_resolved 事件；
 *   就地更新传入 task 的 inputProtocol（引擎后续 assembleContext 直接可见）。
 * - 分层装备：人设 tools（∩注册表归一化匹配）+ 蓝图战绩工具 + 常用自动带（成功 ≥5 次 JOIN task 取 assignee）。
 * - 质量排序与挑战：质量差（成功率 <0.5 且 ≥5 次）的能力列同能力替代为换用建议。
 * - 冷路径：缺口 → 幂等派 [装备请示] 给能力管理隐形岗（每能力一个未收口请示；重复调用不重派）。
 * - buildToolChainSection 渲染：默认套装提示 + 排序装备 + 换用建议。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent, listAgents } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, type Task } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import {
  resolveToolChain,
  buildToolChainSnapshot,
  buildToolChainSection,
  DEFAULT_TOOL_KIT,
  FREQUENT_TOOL_THRESHOLD,
} from '../../src/server/domain/tool-chain';
import {
  ensureCapabilityManagerAgentId,
  CAPABILITY_ROLE,
  getCapabilityManagerAgentId,
} from '../../src/server/domain/system-agents';
import { recordCapabilityUsage } from '../../src/server/domain/capability-quality';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

function seed() {
  const c = restoreWorkbench(db, { id: 'wb_toolchain_1', name: '公司' });
  const lead = createAgent(db, { companyId: c.id, name: '干员', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir: '/tmp/toolchain', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

function withPersonaTask(pId: string, assignee: string, personaId: string | null, extra: Record<string, unknown> = {}): Task {
  return createTask(db, {
    projectId: pId, assigneeAgentId: assignee, title: '带装备的任务',
    ...(personaId ? { personaId } : {}),
    inputProtocol: extra,
  });
}

/** 测试自播种注册表（真实 registry 由 server 启动时 syncToolRegistry 扫描 tools/*.md，测试库为空）。 */
function insertActiveTool(id: string, capabilityId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tool_registry (id, capability_id, implementation, title, file_path, created_at, updated_at)
     VALUES (?, ?, 'local', ?, ?, ?, ?)`,
  ).run(id, capabilityId, id, `${id}.md`, now, now);
}

describe('能力管理岗（冷路径实体）', () => {
  it('懒确保幂等；花名册不可见（隐形）；role=capability-manager', () => {
    seed();
    expect(getCapabilityManagerAgentId(db)).toBeNull();
    const id = ensureCapabilityManagerAgentId(db);
    expect(id).toMatch(/^ag_/);
    expect(ensureCapabilityManagerAgentId(db)).toBe(id);
    const roster = listAgents(db);
    expect(roster.some((a) => a.id === id)).toBe(false); // 隐形：不进花名册
    const row = db.prepare('SELECT role, is_system FROM agent_definition WHERE id=?').get(id) as { role: string; is_system: number };
    expect(row.role).toBe(CAPABILITY_ROLE);
    expect(row.is_system).toBe(1);
  });
});

describe('resolveToolChain 热路径', () => {
  it('快照持久化 + 事件留痕 + 就地更新 task.inputProtocol', () => {
    const { lead, p } = seed();
    const task = withPersonaTask(p.id, lead.id, null);
    const snapshot = resolveToolChain(db, task, []);
    expect(snapshot.defaultKit).toEqual([...DEFAULT_TOOL_KIT]);
    expect(snapshot.resolvedAt).toBeTruthy();
    // 持久化
    const persisted = (getTask(db, task.id).inputProtocol as Record<string, unknown>).resolvedToolChain as { tools: unknown[] };
    expect(Array.isArray(persisted.tools)).toBe(true);
    // 就地更新
    expect(((task.inputProtocol as Record<string, unknown>).resolvedToolChain as { resolvedAt: string }).resolvedAt).toBe(snapshot.resolvedAt);
    // 事件
    expect(listTaskEvents(db, task.id).some((e) => e.kind === 'tool_chain_resolved')).toBe(true);
  });

  it('分层：人设 tools 归一化命中注册表；蓝图战绩工具并入', () => {
    const { lead, p } = seed();
    insertActiveTool('builtin-web-research', 'web-research');
    insertActiveTool('webfetch', 'web-research');
    // 人设：product-manager 声明 WebFetch/WebSearch/Read/Write/Edit（frontmatter tools）
    const task = withPersonaTask(p.id, lead.id, 'product/product-manager', {
      blueprintTools: ['builtin-web-research'],
    });
    const snapshot = buildToolChainSnapshot(db, task, []);
    const ids = snapshot.tools.map((t) => t.toolId);
    expect(ids).toContain('builtin-web-research');
    expect(ids).toContain('webfetch'); // WebFetch 归一化命中注册表
    expect(snapshot.tools.find((t) => t.toolId === 'builtin-web-research')?.source).toBe('blueprint');
    expect(snapshot.tools.find((t) => t.toolId === 'webfetch')?.source).toBe('persona');
    // 注册表外的人设工具（websearch/read/write/edit）不进——建议不是门禁，走文本兜底
    expect(ids).not.toContain('websearch');
  });

  it('常用自动带：该执行者成功使用 ≥ 阈值 的工具默认携带（JOIN task 取 assignee）', () => {
    const { c, lead, p } = seed();
    insertActiveTool('builtin-web-research', 'web-research');
    const other = createAgent(db, { companyId: c.id, name: '别人', role: 'specialist' });
    // lead 名下任务成功用 web-research FREQUENT 次；other 名下只 1 次
    const t1 = withPersonaTask(p.id, lead.id, null);
    const t2 = withPersonaTask(p.id, other.id, null);
    for (let i = 0; i < FREQUENT_TOOL_THRESHOLD; i++) {
      recordCapabilityUsage(db, { capabilityId: 'web-research', toolId: 'builtin-web-research', outcome: 'success', durationMs: 100, taskId: t1.id });
    }
    recordCapabilityUsage(db, { capabilityId: 'web-research', toolId: 'builtin-web-research', outcome: 'success', durationMs: 100, taskId: t2.id });
    const snapLead = buildToolChainSnapshot(db, getTask(db, t1.id), []);
    expect(snapLead.tools.some((t) => t.toolId === 'builtin-web-research' && t.source === 'frequent')).toBe(true);
    const snapOther = buildToolChainSnapshot(db, getTask(db, t2.id), []);
    expect(snapOther.tools.some((t) => t.source === 'frequent')).toBe(false);
  });

  it('质量挑战：能力成功率 <0.5 且 ≥5 次 → 列同能力替代为换用建议', () => {
    const { lead, p } = seed();
    insertActiveTool('builtin-web-research', 'web-research');
    insertActiveTool('better-research', 'web-research'); // 同能力替代实现
    const t1 = withPersonaTask(p.id, lead.id, null, { blueprintTools: ['builtin-web-research'] });
    // 6 次 fail → successRate 0
    for (let i = 0; i < 6; i++) {
      recordCapabilityUsage(db, { capabilityId: 'web-research', toolId: 'builtin-web-research', outcome: 'fail', durationMs: 100, taskId: t1.id });
    }
    const snapshot = buildToolChainSnapshot(db, getTask(db, t1.id), []);
    const repl = snapshot.suggestedReplacements.find((r) => r.capabilityId === 'web-research');
    expect(repl).toBeDefined();
    expect(repl!.alternatives.join(',')).toContain('better-research');
  });
});

describe('冷路径：[装备请示]', () => {
  it('缺口触发派发给能力管理；幂等不重派', () => {
    const { lead, p } = seed();
    const task = withPersonaTask(p.id, lead.id, null);
    const gaps = [{ capabilityId: 'speech-to-text', purpose: '语音转文字', reason: '无任何已启用工具实现' }];
    resolveToolChain(db, task, gaps);
    const managerId = ensureCapabilityManagerAgentId(db);
    const requests = db.prepare("SELECT id, assignee_agent_id FROM task WHERE title LIKE '[装备请示]%'").all() as Array<{ id: string; assignee_agent_id: string }>;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.assignee_agent_id).toBe(managerId);
    expect(listTaskEvents(db, task.id).some((e) => e.kind === 'equipment_request_dispatched')).toBe(true);
    // 幂等：另一任务同能力缺口 → 不重派
    const task2 = withPersonaTask(p.id, lead.id, null);
    resolveToolChain(db, task2, gaps);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM task WHERE title LIKE '[装备请示]%'").get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('buildToolChainSection 渲染', () => {
  it('默认套装提示 + 排序装备 + 换用建议；空快照返回 null', () => {
    expect(buildToolChainSection({})).toBeNull();
    const section = buildToolChainSection({
      defaultKit: ['read', 'write'],
      tools: [{ toolId: 'builtin-web-research', title: '网页调研', source: 'blueprint', reason: '打法常用', quality: { successRate: 0.9, totalCalls: 12 } }],
      suggestedReplacements: [{ capabilityId: 'stt', reason: '成功率低', alternatives: ['whisper-stt（本地）'] }],
    });
    expect(section).toContain('默认套装');
    expect(section).toContain('builtin-web-research');
    expect(section).toContain('成功率 90%');
    expect(section).toContain('whisper-stt');
  });
});
