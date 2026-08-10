/**
 * API 执行器能力提示按探针结果分化（阶段二任务 2.3）单元测试。
 *
 * 验证：
 * 1. hasCommandCapability：CLI 恒 true；API 无探针 false；探针显示 functionCalling+toolLoop → true
 * 2. assembleContext：具备命令能力的 API 注入「可调用 run_command」提示；不具备保持「无命令执行能力」
 * 3. capability-probe note：按真实能力推导命令执行结论
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from '../integration/setup';
import { setDbForTest } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { hasCommandCapability, getCapabilityProbeForProfile } from '../../src/server/domain/capability-probe';
import { assembleContext } from '../../src/server/executors/context';
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
  const project = createProject(db, {
    companyId: c.id,
    name: 'p',
    rootDir: makeTempGitRepo(),
    firstAgentId: lead.id,
    initialState: 'active',
  });
  const task = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '普通任务' });
  return { c, lead, project, task };
}

/** 写入一条 capability 探针结果。 */
function seedCapabilityProbe(profileId: string, result: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO connection_probe (id, executor_profile_id, cache_key, kind, model, status, capability_json, version, created_at, completed_at)
     VALUES (?, ?, 'k', 'capability', 'm', 'connected', ?, '1', ?, ?)`,
  ).run('probe_' + profileId, profileId, JSON.stringify(result), new Date().toISOString(), new Date().toISOString());
}

describe('hasCommandCapability（阶段二任务 2.3）', () => {
  it('CLI 型恒具备命令能力', () => {
    const { c } = fixture();
    const profile = createExecutorProfile(db, { name: 'CLI', manifestId: 'claude-code-cli', config: {} });
    expect(hasCommandCapability(db, profile.id, 'cli')).toBe(true);
    expect(hasCommandCapability(db, null, 'cli')).toBe(true);
    void c;
  });

  it('API 型无探针结果时不具备命令能力', () => {
    const { c } = fixture();
    const profile = createExecutorProfile(db, { name: 'API', manifestId: 'openai-compatible-api', config: { model: 'm' } });
    expect(hasCommandCapability(db, profile.id, 'api')).toBe(false);
    expect(hasCommandCapability(db, null, 'api')).toBe(false);
    void c;
  });

  it('API 型探针显示 functionCalling+toolLoop 完整时具备命令能力', () => {
    const { c } = fixture();
    const profile = createExecutorProfile(db, { name: 'API', manifestId: 'openai-compatible-api', config: { model: 'm' } });
    seedCapabilityProbe(profile.id, { functionCalling: true, toolLoop: true, structuredOutput: true, instructionLevel: 'high' });
    expect(hasCommandCapability(db, profile.id, 'api')).toBe(true);
    expect(getCapabilityProbeForProfile(db, profile.id)).not.toBeNull();
    void c;
  });

  it('API 型探针 functionCalling 缺失时不具备命令能力', () => {
    const { c } = fixture();
    const profile = createExecutorProfile(db, { name: 'API', manifestId: 'openai-compatible-api', config: { model: 'm' } });
    seedCapabilityProbe(profile.id, { functionCalling: false, toolLoop: false, structuredOutput: false, instructionLevel: 'low' });
    expect(hasCommandCapability(db, profile.id, 'api')).toBe(false);
    void c;
  });
});

describe('assembleContext 能力边界提示按探针分化', () => {
  it('具备命令能力的 API 注入「可调用 run_command」提示，不再声明无命令能力', () => {
    const { task } = fixture();
    const assembled = assembleContext(db, task, {
      executorKind: 'api',
      executorHasCommandCapability: true,
    });
    expect(assembled.systemPrompt).toContain('具备命令执行能力');
    expect(assembled.systemPrompt).toContain('run_command');
    expect(assembled.systemPrompt).not.toContain('没有命令执行能力');
  });

  it('不具备命令能力的 API 保持「没有命令执行能力」提示', () => {
    const { task } = fixture();
    const assembled = assembleContext(db, task, {
      executorKind: 'api',
      executorHasCommandCapability: false,
    });
    expect(assembled.systemPrompt).toContain('没有命令执行能力');
  });

  it('未传入能力判定时保持原有行为（不注入命令能力提示）', () => {
    const { task } = fixture();
    const assembled = assembleContext(db, task, { executorKind: 'api' });
    expect(assembled.systemPrompt).toContain('没有命令执行能力');
  });
});
