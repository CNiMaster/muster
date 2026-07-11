import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent, deleteAgent, recruitAgentProfile, updateAgent } from '../../src/server/domain/agent';
import {
  createAgentProfile,
  getAgentProfile,
  getCompanyEmployee,
  listProfileEmployments,
  updateAgentProfile,
} from '../../src/server/domain/agent-profile';
import { makeTestDb } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

describe('Agent Profile and company employment', () => {
  it('新员工在同一事务内创建全局档案和兼容任职记录', () => {
    const company = createCompany(db, { name: '软件公司' });
    const agent = createAgent(db, {
      companyId: company.id,
      name: '小林',
      role: 'engineer',
      responsibilities: '实现功能',
      systemPrompt: '保持严谨',
      skills: ['typescript'],
    });

    expect(agent.profileId).toMatch(/^ap_/);
    expect(getAgentProfile(db, agent.profileId).displayName).toBe('小林');
    expect(getCompanyEmployee(db, agent.id)).toMatchObject({
      id: agent.id,
      legacyAgentId: agent.id,
      profileId: agent.profileId,
      companyId: company.id,
      role: 'engineer',
    });
  });

  it('同一 Profile 可跨公司任职，但岗位上下文相互隔离', () => {
    const firstCompany = createCompany(db, { name: '甲公司' });
    const secondCompany = createCompany(db, { name: '乙公司' });
    const profile = createAgentProfile(db, {
      displayName: '阿青',
      soul: '善于拆解复杂问题',
      capabilities: { skills: ['analysis'] },
    });

    const first = recruitAgentProfile(db, { companyId: firstCompany.id, profileId: profile.id, role: 'architect' });
    const second = recruitAgentProfile(db, { companyId: secondCompany.id, profileId: profile.id, role: 'reviewer' });

    expect(first.id).not.toBe(second.id);
    expect(first.profileId).toBe(profile.id);
    expect(second.profileId).toBe(profile.id);
    expect(listProfileEmployments(db, profile.id).map((item) => item.role).sort()).toEqual(['architect', 'reviewer']);
  });

  it('修改任职岗位不改变全局身份和能力', () => {
    const company = createCompany(db, { name: '公司' });
    const profile = createAgentProfile(db, { displayName: '小周', soul: '独立思考', capabilities: { skills: ['review'] } });
    const employee = recruitAgentProfile(db, { companyId: company.id, profileId: profile.id, role: 'reviewer' });

    updateAgent(db, employee.id, { role: 'lead', responsibilities: '负责项目' });

    expect(getCompanyEmployee(db, employee.id).role).toBe('lead');
    expect(getAgentProfile(db, profile.id)).toMatchObject({ soul: '独立思考', capabilities: { skills: ['review'] } });
  });

  it('删除任职不会删除 Profile', () => {
    const company = createCompany(db, { name: '公司' });
    const profile = createAgentProfile(db, { displayName: '小吴' });
    const employee = recruitAgentProfile(db, { companyId: company.id, profileId: profile.id, role: 'assistant' });

    deleteAgent(db, employee.id);

    expect(getAgentProfile(db, profile.id).displayName).toBe('小吴');
    expect(listProfileEmployments(db, profile.id)).toEqual([]);
  });

  it('更新全局档案不会覆盖任职岗位', () => {
    const company = createCompany(db, { name: '公司' });
    const profile = createAgentProfile(db, { displayName: '旧名字' });
    const employee = recruitAgentProfile(db, { companyId: company.id, profileId: profile.id, role: 'writer' });

    updateAgentProfile(db, profile.id, { displayName: '新名字', soul: '新的长期身份' });

    expect(getAgentProfile(db, profile.id).displayName).toBe('新名字');
    expect(getCompanyEmployee(db, employee.id).role).toBe('writer');
  });
});
