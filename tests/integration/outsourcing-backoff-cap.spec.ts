/**
 * 外包自动接受退避封顶（spec 2026-08-12-subagent-observability B3）集成测试。
 *
 * 验证：
 * 1. 自动路径不清零计数 → 退避在失败循环中能累计 → 达 max_attempts 转 auto_accept_disabled 终态。
 * 2. autoAcceptContract 对 auto_accept_disabled 契约直接返回（不再重试）。
 * 3. 手动 acceptContract 清零计数（用户接管后重新开始）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest, type DB } from '../../src/server/db/client';
import { createCompany, transitionCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import {
  createOutsourcingContract,
  acceptContract,
  revertAcceptToPending,
  autoAcceptContract,
  getOutsourcingContract,
} from '../../src/server/domain/outsourcing-contract';
import { DEFAULT_AUTO_ACCEPT_MAX_ATTEMPTS } from '../../src/shared/constants';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
  setDbForTest(db);
});

function fixture() {
  const a = createCompany(db, { name: '甲方' });
  const b = createCompany(db, { name: '乙方' });
  const aLead = createAgent(db, { companyId: a.id, name: 'a-lead', role: 'lead' });
  const bLead = createAgent(db, { companyId: b.id, name: 'b-lead', role: 'lead' });
  const project = createProject(db, { companyId: a.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: aLead.id, initialState: 'active' });
  transitionCompany(db, a.id, 'online');
  return { a, b, aLead, bLead, project };
}

describe('外包自动接受退避封顶（B3）', () => {
  it('默认上限为 DEFAULT_AUTO_ACCEPT_MAX_ATTEMPTS', () => {
    const { a, b, project } = fixture();
    const c = createOutsourcingContract(db, {
      sourceCompanyId: a.id, targetCompanyId: b.id, sourceProjectId: project.id, title: 't', brief: 'b',
    });
    expect(getOutsourcingContract(db, c.id).autoAcceptMaxAttempts).toBe(DEFAULT_AUTO_ACCEPT_MAX_ATTEMPTS);
  });

  it('自动路径不清零计数：反复 accept(自动)→revert 累计达上限转 auto_accept_disabled', () => {
    const { a, b, bLead, project } = fixture();
    const c = createOutsourcingContract(db, {
      sourceCompanyId: a.id, targetCompanyId: b.id, sourceProjectId: project.id, title: 't', brief: 'b',
    });
    // 测试加速：把上限调到 2。
    db.prepare('UPDATE outsourcing_contract SET auto_accept_max_attempts = 2 WHERE id = ?').run(c.id);

    // 循环 1：accept(自动,不清零) → revert → 计数 1
    acceptContract(db, c.id, bLead.id, { resetBackoff: false });
    let contract = revertAcceptToPending(db, c.id, true);
    expect(contract.autoAcceptAttemptCount).toBe(1);
    expect(contract.state).toBe('pending');

    // 循环 2：accept(自动) → revert → 计数 2（仍未超上限）
    acceptContract(db, c.id, bLead.id, { resetBackoff: false });
    contract = revertAcceptToPending(db, c.id, true);
    expect(contract.autoAcceptAttemptCount).toBe(2);
    expect(contract.state).toBe('pending');

    // 循环 3：accept(自动) → revert → 计数 3 > 上限 2 → 转 auto_accept_disabled
    acceptContract(db, c.id, bLead.id, { resetBackoff: false });
    contract = revertAcceptToPending(db, c.id, true);
    expect(contract.state).toBe('auto_accept_disabled');
    expect(contract.autoAcceptAttemptCount).toBe(3);
  });

  it('auto_accept_disabled 契约不再被 autoAcceptContract 重试', () => {
    const { a, b, bLead, project } = fixture();
    transitionCompany(db, b.id, 'online');
    const c = createOutsourcingContract(db, {
      sourceCompanyId: a.id, targetCompanyId: b.id, sourceProjectId: project.id, title: 't', brief: 'b',
    });
    db.prepare('UPDATE outsourcing_contract SET auto_accept_max_attempts = 1, state = ? WHERE id = ?').run('auto_accept_disabled', c.id);

    // 即便乙方在线、退避已过，disabled 终态也不应被自动接受重新拾起。
    const result = autoAcceptContract(db, c.id);
    expect(getOutsourcingContract(db, c.id).state).toBe('auto_accept_disabled');
    // autoAcceptContract 对非 pending 返回 contract 本身（非 null），但状态不变。
    expect(result?.state).toBe('auto_accept_disabled');
  });

  it('手动 acceptContract 清零计数（用户接管后可重新开始）', () => {
    const { a, b, bLead, project } = fixture();
    const c = createOutsourcingContract(db, {
      sourceCompanyId: a.id, targetCompanyId: b.id, sourceProjectId: project.id, title: 't', brief: 'b',
    });
    // 累计一次失败计数。
    acceptContract(db, c.id, bLead.id, { resetBackoff: false });
    revertAcceptToPending(db, c.id, true);
    expect(getOutsourcingContract(db, c.id).autoAcceptAttemptCount).toBe(1);

    // 手动接受（默认 resetBackoff=true）清零。
    acceptContract(db, c.id, bLead.id);
    expect(getOutsourcingContract(db, c.id).autoAcceptAttemptCount).toBe(0);
  });

  it('autoAcceptContract 在 accept 前封顶：次数达上限直接转 disabled（真正 honoring 上限，不多发一次）', () => {
    const { a, b, project } = fixture();
    transitionCompany(db, b.id, 'online');
    const c = createOutsourcingContract(db, {
      sourceCompanyId: a.id, targetCompanyId: b.id, sourceProjectId: project.id, title: 't', brief: 'b',
    });
    // 模拟已连续失败到上限（count=2, max=2）。
    db.prepare('UPDATE outsourcing_contract SET auto_accept_max_attempts = 2, auto_accept_attempt_count = 2 WHERE id = ?').run(c.id);

    autoAcceptContract(db, c.id);
    // 预检在 accept 前判封顶 → 直接转终态，不会发出第 3 次 accept。
    expect(getOutsourcingContract(db, c.id).state).toBe('auto_accept_disabled');
  });
});
