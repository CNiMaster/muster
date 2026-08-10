/**
 * 执行器三级默认（阶段二任务 2.1）单元测试。
 *
 * 验证：
 * 1. tierForTask：讨论/咨询/轻量 → tertiary；REQUIRES_CLI_SKILLS → primary；其他 → secondary
 * 2. selectTieredExecutorProfile：公司级覆盖 > 全局级；profile 缺失自动降级
 * 3. 员工显式绑定优先级高于三级默认（engine 集成验证见 engine-wiring）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from '../integration/setup';
import { setDbForTest } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { setSetting } from '../../src/server/domain/setting';
import { tierForTask, selectTieredExecutorProfile } from '../../src/server/domain/executor-tier';
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
  return { c, lead, project };
}

function makeProfiles() {
  const primary = createExecutorProfile(db, {
    name: '主力 CLI',
    manifestId: 'claude-code-cli',
    config: { binaryPath: '/usr/local/bin/claude' },
  });
  const secondary = createExecutorProfile(db, {
    name: '标准 API',
    manifestId: 'openai-compatible-api',
    config: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  });
  const tertiary = createExecutorProfile(db, {
    name: '小活模型',
    manifestId: 'gemini-api',
    config: { model: 'gemini-2.0-flash' },
  });
  return { primary, secondary, tertiary };
}

describe('tierForTask（任务标签 → 执行器级别）', () => {
  it('讨论/咨询/轻量任务 → tertiary', () => {
    const { lead, project } = fixture();
    const discussion = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '讨论', isDiscussion: true });
    expect(tierForTask(discussion)).toBe('tertiary');

    const consult = createTask(db, {
      projectId: project.id,
      assigneeAgentId: lead.id,
      title: '咨询',
      inputProtocol: { consultation: true, lightweight: true },
    });
    expect(tierForTask(consult)).toBe('tertiary');

    const light = createTask(db, {
      projectId: project.id,
      assigneeAgentId: lead.id,
      title: '轻量',
      inputProtocol: { lightweight: true },
    });
    expect(tierForTask(light)).toBe('tertiary');
  });

  it('需要 CLI 的 skill → primary', () => {
    const { lead, project } = fixture();
    const task = createTask(db, {
      projectId: project.id,
      assigneeAgentId: lead.id,
      title: '跑测试',
      requiredSkillIds: ['test-driven-development'],
    });
    expect(tierForTask(task)).toBe('primary');
  });

  it('普通任务 → secondary', () => {
    const { lead, project } = fixture();
    const task = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '写文档' });
    expect(tierForTask(task)).toBe('secondary');
  });
});

describe('selectTieredExecutorProfile（三级默认选择 + 降级）', () => {
  it('未配置三级时返回 null（回退 defaultProvider）', () => {
    const { lead, project } = fixture();
    const task = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '普通任务' });
    expect(selectTieredExecutorProfile(db, task, project.companyId)).toBeNull();
  });

  it('按任务标签选对应级别（全局级）', () => {
    const { lead, project } = fixture();
    const { primary, secondary, tertiary } = makeProfiles();
    setSetting(db, 'executor_tier_primary_id', primary.id);
    setSetting(db, 'executor_tier_secondary_id', secondary.id);
    setSetting(db, 'executor_tier_tertiary_id', tertiary.id);

    const heavy = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '跑测试', requiredSkillIds: ['ci-cd-and-automation'] });
    expect(selectTieredExecutorProfile(db, heavy, project.companyId)?.id).toBe(primary.id);

    const standard = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '写文档' });
    expect(selectTieredExecutorProfile(db, standard, project.companyId)?.id).toBe(secondary.id);

    const light = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '轻量', inputProtocol: { lightweight: true } });
    expect(selectTieredExecutorProfile(db, light, project.companyId)?.id).toBe(tertiary.id);
  });

  it('公司级覆盖优先于全局级', () => {
    const { c, lead, project } = fixture();
    const { primary, secondary } = makeProfiles();
    setSetting(db, 'executor_tier_primary_id', primary.id);
    // 公司级把 primary 覆盖为 secondary
    db.prepare('UPDATE company SET executor_tier_primary_id=? WHERE id=?').run(secondary.id, c.id);

    const heavy = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '跑测试', requiredSkillIds: ['ci-cd-and-automation'] });
    expect(selectTieredExecutorProfile(db, heavy, project.companyId)?.id).toBe(secondary.id);
  });

  it('目标级未配置或 profile 缺失时自动降级', () => {
    const { lead, project } = fixture();
    const { secondary, tertiary } = makeProfiles();
    // primary 未配置，secondary 已配置 → 重活降级到 secondary
    setSetting(db, 'executor_tier_secondary_id', secondary.id);
    setSetting(db, 'executor_tier_tertiary_id', tertiary.id);
    const heavy = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '跑测试', requiredSkillIds: ['ci-cd-and-automation'] });
    expect(selectTieredExecutorProfile(db, heavy, project.companyId)?.id).toBe(secondary.id);

    // primary 配置了但 profile 被删除 → 继续降级到 secondary
    setSetting(db, 'executor_tier_primary_id', 'ep_deleted_profile');
    expect(selectTieredExecutorProfile(db, heavy, project.companyId)?.id).toBe(secondary.id);

    // 全部未配置 → null
    setSetting(db, 'executor_tier_secondary_id', '');
    setSetting(db, 'executor_tier_tertiary_id', '');
    expect(selectTieredExecutorProfile(db, heavy, project.companyId)).toBeNull();
  });
});
