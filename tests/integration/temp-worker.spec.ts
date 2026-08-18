import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 临时工生命周期测试：招聘 → greyed → 转正 / 开除两种路径 / is_temp_only 区分。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createAgent, getAgent } from '../../src/server/domain/agent';
import {
  createTempEmployment,
  convertTempToPermanent,
  markTempGreyed,
  dismissTempWorker,
  reactivateGreyedTemp,
  findGreyedTempForReuse,
} from '../../src/server/domain/temp-worker';
import { selectTempForNeed } from '../../src/server/domain/outsourcing-decision';
import { listAgentProfiles } from '../../src/server/domain/agent-profile';
import { AppError } from '../../src/shared/errors';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;
let leadAgent: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  companyId = restoreWorkbench(db, { id: 'wb_fix_1', name: '测试公司' }).id;
  leadAgent = createAgent(db, {
    name: '负责人',
    role: 'lead',
    systemPrompt: '',
    skills: [],
    tools: [],
    permissions: {},
    executor: {},
  }).id;
  db.prepare("UPDATE workbench SET state='online', first_agent_id=? WHERE id=?").run(leadAgent, companyId);
});

afterEach(() => tdb.close());

function getEmployment(db: DB, agentId: string) {
  return db.prepare(
    'SELECT employment_type, temp_status, source_contract_id FROM company_employee WHERE legacy_agent_id=?',
  ).get(agentId) as { employment_type: string; temp_status: string | null; source_contract_id: string | null };
}

describe('临时工招聘', () => {
  it('新建临时工：is_temp_only=1，不进人才市场', () => {
    const result = createTempEmployment(db, {
      role: 'ui-design',
      responsibilities: '做 UI 设计',
    });
    expect(result.isNewProfile).toBe(true);
    // company_employee 标记为 temp/active
    const emp = getEmployment(db, result.agentId);
    expect(emp.employment_type).toBe('temp');
    expect(emp.temp_status).toBe('active');
    // profile 标记 is_temp_only=1
    const profile = db.prepare('SELECT is_temp_only FROM agent_profile WHERE id=?').get(result.profileId) as { is_temp_only: number };
    expect(profile.is_temp_only).toBe(1);
    // 人才市场过滤掉临时工
    const market = listAgentProfiles(db);
    expect(market.find((p) => p.id === result.profileId)).toBeUndefined();
  });

  it('复用人才市场现有人：is_temp_only 不变，出现在人才市场', () => {
    // 先下班，正常招一个正式员工（进人才市场）
    db.prepare("UPDATE workbench SET state='off' WHERE id=?").run(companyId);
    const perm = createAgent(db, {
      name: '正式员工',
      role: 'engineer',
      systemPrompt: '',
      skills: [],
      tools: [],
      permissions: {},
      executor: {},
    });
    db.prepare("UPDATE workbench SET state='online' WHERE id=?").run(companyId);
    const permProfile = getAgent(db, perm.id).profileId;

    const result = createTempEmployment(db, {
      profileId: permProfile,
      role: 'temp-task',
    });
    expect(result.isNewProfile).toBe(false);
    expect(result.profileId).toBe(permProfile);
    // is_temp_only 仍为 0
    const profile = db.prepare('SELECT is_temp_only FROM agent_profile WHERE id=?').get(permProfile) as { is_temp_only: number };
    expect(profile.is_temp_only).toBe(0);
    // 仍在人才市场
    const market = listAgentProfiles(db);
    expect(market.find((p) => p.id === permProfile)).toBeTruthy();
  });
});

describe('临时工 greyed（完成工作）', () => {
  it('active → greyed', () => {
    const result = createTempEmployment(db, { role: 'designer' });
    markTempGreyed(db, result.agentId);
    expect(getEmployment(db, result.agentId).temp_status).toBe('greyed');
  });

  it('非临时工 greyed 无操作', () => {
    markTempGreyed(db, leadAgent); // 正式员工，无操作不报错
    const emp = getEmployment(db, leadAgent);
    expect(emp.temp_status).toBeNull();
  });

  it('重复 greyed 幂等', () => {
    const result = createTempEmployment(db, { role: 'designer' });
    markTempGreyed(db, result.agentId);
    markTempGreyed(db, result.agentId); // 不报错
    expect(getEmployment(db, result.agentId).temp_status).toBe('greyed');
  });
});

describe('临时工转正', () => {
  it('转正后 employment_type=permanent，is_temp_only 清零（进人才市场）', () => {
    const result = createTempEmployment(db, { role: 'designer' });
    convertTempToPermanent(db, result.agentId);
    const emp = getEmployment(db, result.agentId);
    expect(emp.employment_type).toBe('permanent');
    expect(emp.temp_status).toBeNull();
    // is_temp_only 清零，进入人才市场
    const profile = db.prepare('SELECT is_temp_only FROM agent_profile WHERE id=?').get(result.profileId) as { is_temp_only: number };
    expect(profile.is_temp_only).toBe(0);
    const market = listAgentProfiles(db);
    expect(market.find((p) => p.id === result.profileId)).toBeTruthy();
  });

  it('正式员工转正报错', () => {
    expect(() => convertTempToPermanent(db, leadAgent)).toThrow(/不是临时工/);
  });
});

describe('临时工开除', () => {
  it('新建临时工未转正开除：删 profile + 不进人才市场', () => {
    const result = createTempEmployment(db, { role: 'designer' });
    const profileId = result.profileId;
    dismissTempWorker(db, result.agentId, { confirm: true });
    // profile 已删
    const profile = db.prepare('SELECT id FROM agent_profile WHERE id=?').get(profileId);
    expect(profile).toBeUndefined();
    // agent_definition 已删
    expect(() => getAgent(db, result.agentId)).toThrow();
  });

  it('开除需二次确认', () => {
    const result = createTempEmployment(db, { role: 'designer' });
    expect(() => dismissTempWorker(db, result.agentId, { confirm: false })).toThrow(/确认/);
  });

  it('人才市场来的人开除：保留 profile（仍在人才市场）', () => {
    db.prepare("UPDATE workbench SET state='off' WHERE id=?").run(companyId);
    const perm = createAgent(db, {
      name: '可复用员工',
      role: 'engineer',
      systemPrompt: '',
      skills: [],
      tools: [],
      permissions: {},
      executor: {},
    });
    db.prepare("UPDATE workbench SET state='online' WHERE id=?").run(companyId);
    const permProfile = getAgent(db, perm.id).profileId;
    // 作为临时工复用到同公司（简化测试：直接构造 is_temp_only=0 的临时工）
    const result = createTempEmployment(db, { profileId: permProfile, role: 'temp' });
    dismissTempWorker(db, result.agentId, { confirm: true });
    // profile 保留
    const profile = db.prepare('SELECT id FROM agent_profile WHERE id=?').get(permProfile);
    expect(profile).toBeTruthy();
  });

  it('开除正式员工报错', () => {
    expect(() => dismissTempWorker(db, leadAgent, { confirm: true })).toThrow(/不是临时工/);
  });
});

describe('临时工小范围关系（contactAllow 只含发起者）', () => {
  it('临时工的 contactAllow 仅含发起需求者', () => {
    const result = createTempEmployment(db, {
      role: 'designer',
      requesterAgentId: leadAgent,
    });
    const agent = db.prepare('SELECT contact_allow_json FROM agent_definition WHERE id=?').get(result.agentId) as { contact_allow_json: string };
    expect(JSON.parse(agent.contact_allow_json)).toEqual([leadAgent]);
  });

  it('无发起者时 contactAllow 为空', () => {
    const result = createTempEmployment(db, { role: 'designer' });
    const agent = db.prepare('SELECT contact_allow_json FROM agent_definition WHERE id=?').get(result.agentId) as { contact_allow_json: string };
    expect(JSON.parse(agent.contact_allow_json)).toEqual([]);
  });
});

describe('reactivateGreyedTemp 重新激活', () => {
  it('greyed → active', () => {
    const result = createTempEmployment(db, { role: 'designer' });
    markTempGreyed(db, result.agentId);
    expect(getEmployment(db, result.agentId).temp_status).toBe('greyed');
    reactivateGreyedTemp(db, result.agentId);
    expect(getEmployment(db, result.agentId).temp_status).toBe('active');
  });

  it('非 greyed 状态报错', () => {
    const result = createTempEmployment(db, { role: 'designer' });
    // active 态不能 reactivate
    expect(() => reactivateGreyedTemp(db, result.agentId)).toThrow(/仅 greyed/);
  });

  it('正式员工 reactivate 报错', () => {
    expect(() => reactivateGreyedTemp(db, leadAgent)).toThrow(/不是临时工/);
  });
});

describe('findGreyedTempForReuse 查找可复用临时工', () => {
  it('无 greyed 临时工时返回 null', () => {
    expect(findGreyedTempForReuse(db, [])).toBeNull();
  });

  it('有 greyed 临时工时返回（无能力要求）', () => {
    const result = createTempEmployment(db, { role: 'designer' });
    markTempGreyed(db, result.agentId);
    const found = findGreyedTempForReuse(db, []);
    expect(found).toBe(result.agentId);
  });

  it('active 临时工不被选为复用', () => {
    const result = createTempEmployment(db, { role: 'designer' });
    // active，不 greyed
    expect(findGreyedTempForReuse(db, [])).toBeNull();
  });
});

describe('selectTempForNeed 选拔优先级链', () => {
  it('无 greyed 时走创建路径（created）', () => {
    const result = selectTempForNeed(db, [], '临时专员');
    expect(result.path).toBe('created');
    expect(result.isNewProfile).toBe(true);
  });

  it('有 greyed 临时工时优先复用（reactivated）', () => {
    const temp = createTempEmployment(db, { role: 'designer' });
    markTempGreyed(db, temp.agentId);
    const result = selectTempForNeed(db, [], '设计师');
    expect(result.path).toBe('reactivated');
    expect(result.agentId).toBe(temp.agentId);
    // 复用后变回 active
    expect(getEmployment(db, temp.agentId).temp_status).toBe('active');
  });
});
