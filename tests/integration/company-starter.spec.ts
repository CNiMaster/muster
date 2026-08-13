/**
 * 工作台改版 批次 1：一键模板启动 quickStartCompany 集成测试。
 *
 * 验证：选模板→（可选改名）→一键创建公司+项目+首任务；自动套默认执行器/权限；
 * 无执行器→清晰错误；接通人设库（员工 profile soul 不再是薄字符串）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { quickStartCompany } from '../../src/server/domain/company-starter';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { listPermissionPolicies } from '../../src/server/domain/permission';
import { getAgentProfile } from '../../src/server/domain/agent-profile';
import { getCompany } from '../../src/server/domain/company';
import { listMessages } from '../../src/server/domain/conversation';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
});

function givenExecutor(): void {
  createExecutorProfile(db, { name: '测试 API 执行器', manifestId: 'openai-compatible-api' });
}

describe('quickStartCompany（一键模板启动）', () => {
  it('选模板→一键创建公司+项目+首任务，自动套默认执行器/权限', () => {
    givenExecutor();
    const result = quickStartCompany(db, { templateId: 'general' });

    expect(result.company.name).toBe('通用项目公司'); // 默认名取自模板
    expect(result.employees.length).toBeGreaterThan(0);
    expect(result.project.name).toBeTruthy();
    // 首任务作为 ProjectTask 草稿就绪（真正"跑起来"靠对话派发，批次 2）
    expect(result.projectTask.title).toBeTruthy();
    // 公司可查
    expect(getCompany(db, result.company.id).id).toBe(result.company.id);
    // 优化①：一键开跑后公司直接上线
    expect(result.company.state).toBe('online');
    // 优化②：对话首条引导消息（第一负责人打招呼）
    const messages = listMessages(db, 'company', result.company.id);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]!.role).toBe('assistant');
  });

  it('无执行器档案→清晰错误（不静默失败）', () => {
    expect(() => quickStartCompany(db, { templateId: 'general' })).toThrow(/执行器/);
  });

  it('未知模板→错误', () => {
    givenExecutor();
    expect(() => quickStartCompany(db, { templateId: 'no-such-template' })).toThrow(/模板/);
  });

  it('自定义名字/目标生效', () => {
    givenExecutor();
    const result = quickStartCompany(db, { templateId: 'general', name: '我的小队', goal: '搞定一切' });
    expect(result.company.name).toBe('我的小队');
    expect(result.company.charter).toBe('搞定一切');
  });

  it('无权限策略时自动建默认策略并使用', () => {
    givenExecutor();
    expect(listPermissionPolicies(db)).toHaveLength(0);
    quickStartCompany(db, { templateId: 'general' });
    expect(listPermissionPolicies(db).length).toBeGreaterThanOrEqual(1);
  });

  it('接通人设库：能匹配到人设的员工，profile soul 不再是薄字符串模板', () => {
    givenExecutor();
    const result = quickStartCompany(db, { templateId: 'software' });
    // software 含 engineer 角色——人设库 engineering 域应能匹配
    const engineer = result.employees.find((e) => e.role === 'engineer')!;
    expect(engineer).toBeDefined();
    const profile = getAgentProfile(db, engineer.profileId);
    // 薄字符串前缀是"你是<公司>的<名字>"；匹配到人设后应为 persona.soul（不含该前缀）
    expect(profile.soul.startsWith('你是')).toBe(false);
    expect(profile.principles.length).toBeGreaterThan(0);
  });
});
