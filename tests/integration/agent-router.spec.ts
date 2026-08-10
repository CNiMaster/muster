/**
 * 能力路由自动选专家（阶段七任务 7.2）集成测试。
 *
 * 验证：
 * 1. findBestAssignee：按 skills 匹配 + 在线优先 + rating 加分 + 负载惩罚
 * 2. createTask 未指定 assignee 但声明 requiredCapabilityIds 时自动分配
 * 3. 无匹配候选时 fallback 到项目第一负责人
 * 4. spawn_tasks 支持 required_capabilities 自动路由
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { findBestAssignee } from '../../src/server/domain/agent-router';
import { executeTool, createBuiltinToolRegistry, type ToolCall, type ToolContext } from '../../src/server/executors/tools/registry';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

function fixture() {
  const c = createCompany(db, { name: 'co' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const explorer = createAgent(db, { companyId: c.id, name: 'explorer', role: 'explorer', skills: ['code-search', 'research'] });
  const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer', skills: ['writing'] });
  db.prepare('UPDATE agent_definition SET contact_allow_json=? WHERE id=?')
    .run(JSON.stringify([explorer.id, writer.id]), lead.id);
  const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
  return { c, lead, explorer, writer, project };
}

describe('findBestAssignee（能力路由）', () => {
  it('按 skills 匹配能力并优先在线员工', () => {
    const { c, explorer } = fixture();
    // explorer 下班
    db.prepare("UPDATE agent_definition SET availability_state='off' WHERE id=?").run(explorer.id);
    const result = findBestAssignee(db, c.id, ['code-search']);
    expect(result).not.toBeNull();
    // 只有 explorer 有该能力，即使下班也选它（无在线候选）
    expect(result!.agentId).toBe(explorer.id);
    expect(result!.matchedCapabilities).toContain('code-search');
  });

  it('无能力匹配时返回 null', () => {
    const { c } = fixture();
    expect(findBestAssignee(db, c.id, ['nonexistent-capability'])).toBeNull();
  });

  it('负载惩罚：能力相同的员工选负载低的', () => {
    const { c, explorer } = fixture();
    const twin = createAgent(db, { companyId: c.id, name: 'twin', role: 'explorer', skills: ['code-search'] });
    // explorer 有 3 个排队任务
    for (let i = 0; i < 3; i++) {
      createTask(db, { projectId: getFirstProjectId(), assigneeAgentId: explorer.id, title: `排队${i}` });
    }
    const result = findBestAssignee(db, c.id, ['code-search']);
    expect(result!.agentId).toBe(twin.id);
  });

  it('L-5：同分时路由结果稳定（多次调用一致，不随行序抖动）', () => {
    const { c } = fixture();
    createAgent(db, { companyId: c.id, name: 'twin', role: 'explorer', skills: ['code-search'] });
    // 两个员工同能力、同在线、同 rating、同负载（默认 0）→ 完全同分。
    // 集成层验证确定性（多次调用结果一致）；tiebreak 取字典序最小由单元测试
    // tests/unit/agent-router.spec.ts 的 shouldReplaceBest 覆盖（id 随机生成无法在此稳定区分）。
    const results = new Set<string>();
    for (let i = 0; i < 5; i++) {
      results.add(findBestAssignee(db, c.id, ['code-search'])!.agentId);
    }
    expect(results.size).toBe(1); // 5 次调用返回同一个 agent
  });
});

describe('createTask 自动路由（阶段七任务 7.2）', () => {
  it('未指定 assignee 但声明 requiredCapabilityIds 时自动分配', () => {
    const { explorer, project } = fixture();
    const task = createTask(db, {
      projectId: project.id,
      title: '搜索代码库',
      requiredCapabilityIds: ['code-search'],
    });
    expect(task.assigneeAgentId).toBe(explorer.id);
    const proto = task.inputProtocol as Record<string, unknown>;
    expect(proto.routedByCapability).toBe(true);
    expect(proto.routedCandidate).toBe('explorer');
  });

  it('无匹配候选时 fallback 到项目第一负责人', () => {
    const { lead, project } = fixture();
    const task = createTask(db, {
      projectId: project.id,
      title: '特殊任务',
      requiredCapabilityIds: ['magic-capability'],
    });
    expect(task.assigneeAgentId).toBe(lead.id);
    // 无 routedByCapability 标记（未路由成功）
    const proto = task.inputProtocol as Record<string, unknown>;
    expect(proto.routedByCapability).toBeUndefined();
  });

  it('显式 assignee 优先于自动路由', () => {
    const { writer, explorer, project } = fixture();
    const task = createTask(db, {
      projectId: project.id,
      assigneeAgentId: writer.id,
      title: '指定任务',
      requiredCapabilityIds: ['code-search'], // writer 没有该能力
    });
    expect(task.assigneeAgentId).toBe(writer.id);
    void explorer;
  });
});

describe('spawn_tasks 按能力路由（阶段七任务 7.2）', () => {
  it('required_capabilities 自动路由到匹配专家', async () => {
    const { lead, explorer, project } = fixture();
    const parent = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '调研' });
    const call: ToolCall = {
      id: 'tc_spawn',
      name: 'spawn_tasks',
      args: {
        tasks: [{ title: '搜索代码', required_capabilities: ['code-search'] }],
      },
    };
    const ctx: ToolContext = {
      workingDir: '/tmp/worktree',
      readonlyDirs: [],
      toolRegistry: createBuiltinToolRegistry(),
      consultationContext: { db, askerTaskId: parent.id, askerProjectId: project.id, askerProjectTaskId: parent.projectTaskId, askerAgentId: lead.id },
    };
    const result = await executeTool(call, ctx);
    expect(result.content).toContain('已并行派发 1 个子任务');
    const child = db.prepare('SELECT assignee_agent_id FROM task WHERE parent_task_id=?').get(parent.id) as { assignee_agent_id: string };
    expect(child.assignee_agent_id).toBe(explorer.id);
  });
});

function getFirstProjectId(): string {
  const row = db.prepare('SELECT id FROM project LIMIT 1').get() as { id: string };
  return row.id;
}
