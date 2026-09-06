/**
 * 测试辅助：创建临时内存 SQLite + 跑 migration + 临时 git 仓库。
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../src/server/db/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../../src/server/db/migrations');

export interface TestDb {
  db: InstanceType<typeof Database.Database>;
  close: () => void;
}

export function makeTestDb(): TestDb {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  runMigrations(db, migrationsDir);
  return {
    db,
    close: () => db.close(),
  };
}

/**
 * 创建临时 git 仓库作为 project rootDir。
 * 测试中 engine 会调用 createWorktree（需要 git rev-parse HEAD 成功），
 * 所以 rootDir 必须是一个已初始化的 git 仓库。
 */
export function makeTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@muster.dev', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  // 需要至少一个 commit 才能 rev-parse HEAD
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -q -m init', { cwd: dir });
  return dir;
}


/**
 * 测试夹具：长篇小说工作台（原领域函数已随固定岗位模板退场，仅测试保留同构形状）。
 * 生产路径的默认员工 = 负责人 + 验收员（ensureWorkspaceStaff），专家角色由任务穿戴人设生成。
 * 2026-09-06：题材扩展包退役（通用程序不预置领域答案），genres 参数随之移除；
 * 测试需要 worldview/continuity 等岗位时用 createAgent 手工建。
 */
import type { DB } from '../../src/server/db/client';
import { restoreWorkbench, updateWorkbench, type Workbench } from '../../src/server/domain/workbench';
import { createAgent, type AgentDefinition, type CreateAgentInput } from '../../src/server/domain/agent';
import { addRelationship } from '../../src/server/domain/graph';

export interface NovelTemplateResult {
  company: Workbench;
  agents: {
    lead: AgentDefinition;
    writer: AgentDefinition;
    character: AgentDefinition;
    plot: AgentDefinition;
    inspector: AgentDefinition;
  };
}

export function createNovelCompany(db: DB, input: { name: string; charter?: string }): NovelTemplateResult {
  // 唯一 id：同一测试库允许多次实例化（小说项目类测试串行建多个工作台场景已退役，防呆保留）
  const company = restoreWorkbench(db, { id: `wb_novel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name: input.name, kind: 'novel', charter: input.charter });
  const mk = (name: string, role: string, responsibilities: string, extra: Partial<CreateAgentInput> = {}): AgentDefinition =>
    createAgent(db, { companyId: company.id, name, role, responsibilities, contactAllow: [], ...extra });
  const lead = mk('项目负责人', 'lead', '拆解并派发', { canDispatch: true });
  const writer = mk('主写手', 'writer', '撰写正文');
  const character = mk('人物设计', 'character', '维护人物档案');
  const plot = mk('情节架构', 'plot', '维护大纲与伏笔');
  const inspector = mk('运营监察', 'inspector', '观察与建议', { isInspector: true });
  const updatedCompany = updateWorkbench(db, { firstAgentId: lead.id });
  for (const a of [writer, character, plot, inspector]) {
    addRelationship(db, { companyId: company.id, kind: 'org', sourceId: lead.id, targetId: a.id, label: '管辖' });
  }
  // 通信关系（与原领域实现同构）：lead 可联系所有人；writer 可联系创作类岗位求助
  lead.contactAllow = [writer.id, character.id, plot.id, inspector.id];
  writer.contactAllow = [character.id, plot.id, lead.id];
  character.contactAllow = [lead.id, writer.id];
  plot.contactAllow = [lead.id, writer.id];
  for (const a of [lead, writer, character, plot, inspector] as AgentDefinition[]) {
    db.prepare('UPDATE agent_definition SET contact_allow_json=? WHERE id=?').run(JSON.stringify(a.contactAllow), a.id);
  }
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: lead.id, targetId: writer.id, label: '派发' });
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: writer.id, targetId: character.id, label: '求人物资料' });
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: writer.id, targetId: plot.id, label: '求情节资料' });
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: inspector.id, targetId: lead.id, label: '告警' });
  return { company: updatedCompany, agents: { lead, writer, character, plot, inspector } };
}

export function assertLeadWriterSeparate(leadId: string, writerId: string): void {
  if (leadId === writerId) throw new Error('项目负责人与主写手必须由不同员工担任');
}

/**
 * 给小说工作台追加扩展岗位（worldview/continuity/style 等维护岗）：
 * 自动补「管辖」关系与 lead↔岗位双向通信授权——维护 Task 由 lead 派发，createTask 校验通信授权。
 */
export function createNovelExtraAgent(
  db: DB,
  r: NovelTemplateResult,
  name: string,
  role: string,
  responsibilities: string,
): AgentDefinition {
  const agent = createAgent(db, { companyId: r.company.id, name, role, responsibilities, contactAllow: [] });
  addRelationship(db, { companyId: r.company.id, kind: 'org', sourceId: r.agents.lead.id, targetId: agent.id, label: '管辖' });
  const lead = r.agents.lead;
  lead.contactAllow = [...lead.contactAllow, agent.id];
  agent.contactAllow = [lead.id];
  for (const a of [lead, agent]) {
    db.prepare('UPDATE agent_definition SET contact_allow_json=? WHERE id=?').run(JSON.stringify(a.contactAllow), a.id);
  }
  return agent;
}
