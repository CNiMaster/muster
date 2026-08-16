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
 * 生产路径的默认员工 = 第一负责人 + 验收员（ensureWorkspaceStaff），专家角色由任务穿戴人设生成。
 */
import type { DB } from '../../src/server/db/client';
import { createCompany, updateCompany, type Company } from '../../src/server/domain/company';
import { createAgent, type AgentDefinition, type CreateAgentInput } from '../../src/server/domain/agent';
import { addRelationship } from '../../src/server/domain/graph';
import { createDepartment, type Department } from '../../src/server/domain/department';
import { GENRE_EXTENSION_PACKS } from '../../src/server/domain/novel-template';

export interface NovelTemplateResult {
  company: Company;
  departments: Department[];
  agents: {
    lead: AgentDefinition;
    writer: AgentDefinition;
    character: AgentDefinition;
    plot: AgentDefinition;
    inspector: AgentDefinition;
    extra: AgentDefinition[];
  };
}

export function createNovelCompany(db: DB, input: { name: string; charter?: string; departments?: Array<{ name: string; purpose?: string }>; genres?: string[] }): NovelTemplateResult {
  const company = createCompany(db, { name: input.name, kind: 'novel', charter: input.charter });
  const departments = (input.departments?.length ? input.departments : [{ name: '创作部', purpose: '正文、人物与情节协作' }, { name: '运营监察', purpose: '一致性检查' }]).map((d) => createDepartment(db, { companyId: company.id, name: d.name, rules: { purpose: d.purpose ?? '' } }));
  const mk = (name: string, role: string, responsibilities: string, extra: Partial<CreateAgentInput> = {}): AgentDefinition =>
    createAgent(db, { companyId: company.id, departmentId: departments[0]?.id, name, role, responsibilities, contactAllow: [], ...extra });
  const lead = mk('项目第一负责人', 'lead', '拆解并派发', { canDispatch: true });
  const writer = mk('主写手', 'writer', '撰写正文');
  const character = mk('人物设计', 'character', '维护人物档案');
  const plot = mk('情节架构', 'plot', '维护大纲与伏笔');
  const inspector = mk('运营监察', 'inspector', '观察与建议', { isInspector: true, departmentId: departments[1]?.id ?? departments[0]?.id });
  const extra: AgentDefinition[] = [];
  const seen = new Set(['lead', 'writer', 'character', 'plot', 'inspector']);
  for (const genreId of input.genres ?? []) {
    for (const r of GENRE_EXTENSION_PACKS[genreId]?.extraRoles ?? []) {
      if (seen.has(r.role)) continue;
      seen.add(r.role);
      extra.push(mk(r.name, r.role, r.responsibilities));
    }
  }
  const updatedCompany = updateCompany(db, company.id, { firstAgentId: lead.id });
  for (const a of [writer, character, plot, inspector, ...extra]) {
    addRelationship(db, { companyId: company.id, kind: 'org', sourceId: lead.id, targetId: a.id, label: '管辖' });
  }
  // 通信关系（与原领域实现同构）：lead 可联系所有人；writer 可联系创作类岗位求助
  const creativeExtras = extra.filter((e) => e.role !== 'continuity');
  lead.contactAllow = [writer.id, character.id, plot.id, inspector.id, ...extra.map((e) => e.id)];
  writer.contactAllow = [character.id, plot.id, lead.id, ...creativeExtras.map((e) => e.id)];
  character.contactAllow = [lead.id, writer.id];
  plot.contactAllow = [lead.id, writer.id];
  for (const e of extra) {
    e.contactAllow = e.role === 'continuity' ? [lead.id, inspector.id] : [lead.id, writer.id];
  }
  for (const a of [lead, writer, character, plot, inspector, ...extra] as AgentDefinition[]) {
    db.prepare('UPDATE agent_definition SET contact_allow_json=? WHERE id=?').run(JSON.stringify(a.contactAllow), a.id);
  }
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: lead.id, targetId: writer.id, label: '派发' });
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: writer.id, targetId: character.id, label: '求人物资料' });
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: writer.id, targetId: plot.id, label: '求情节资料' });
  addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: inspector.id, targetId: lead.id, label: '告警' });
  for (const e of creativeExtras) {
    addRelationship(db, { companyId: company.id, kind: 'communication', sourceId: writer.id, targetId: e.id, label: '求资料' });
  }
  return { company: updatedCompany, departments, agents: { lead, writer, character, plot, inspector, extra } };
}

export function assertLeadWriterSeparate(leadId: string, writerId: string): void {
  if (leadId === writerId) throw new Error('项目第一负责人与主写手必须由不同员工担任');
}
