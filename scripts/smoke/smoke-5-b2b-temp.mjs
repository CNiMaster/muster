/**
 * 冒烟测试 5：B2B 外包 + 临时工 + 评级。
 */
import { api, assert, assertEq, assertStatus, uname, setupCompany, setupProject, runSuite } from './_helpers.mjs';

let totalPass = 0, totalFail = 0;

const r1 = await runSuite('临时工生命周期', async (check) => {
  const { companyId } = await setupCompany(uname('temp-co'));

  await check('招临时工（新建 profile，is_temp_only=1）', async () => {
    const r = await api.post(`/api/companies/${companyId}/employees/temp`, { role: 'designer', responsibilities: '设计' });
    assertStatus(r, 201, '招临时工');
    assert(r.body.isNewProfile === true, '应为新建 profile');
    assert(!!r.body.agentId && !!r.body.profileId, '有 agentId + profileId');
  });

  await check('列出临时工', async () => {
    const r = await api.get(`/api/companies/${companyId}/employees/temp`);
    assertStatus(r, 200, '临时工列表');
    assert(r.body.length >= 1, `至少 1 个临时工，实际 ${r.body.length}`);
  });

  let convertAgentId;
  await check('转正', async () => {
    const list = await api.get(`/api/companies/${companyId}/employees/temp`);
    convertAgentId = list.body[0].legacy_agent_id;
    const r = await api.post(`/api/companies/${companyId}/employees/${convertAgentId}/convert`, {});
    assertStatus(r, 200, '转正');
  });

  await check('开除临时工（需二次确认）', async () => {
    // 先再招一个用于开除
    const tr = await api.post(`/api/companies/${companyId}/employees/temp`, { role: 'to-dismiss' });
    const aid = tr.body.agentId;
    // 不带 confirm 应失败
    const bad = await api.post(`/api/companies/${companyId}/employees/${aid}/dismiss`, { confirm: false });
    assert(bad.status >= 400, `无 confirm 应失败，实际 ${bad.status}`);
    // 带 confirm 成功
    const r = await api.post(`/api/companies/${companyId}/employees/${aid}/dismiss`, { confirm: true });
    assertStatus(r, 200, '开除');
    assert(typeof r.body.profileDeleted === 'boolean', '返回 profileDeleted');
  });
});

const r2 = await runSuite('评级', async (check) => {
  const { companyId } = await setupCompany(uname('rate-co'));
  const tr = await api.post(`/api/companies/${companyId}/employees/temp`, { role: 'rated' });
  const pid = tr.body.profileId;

  await check('评级明细查询', async () => {
    const r = await api.get(`/api/agent-profiles/${pid}/rating`);
    assertStatus(r, 200, '评级明细');
    assert(typeof r.body.stars === 'number', '有 stars');
    assert(r.body.stars >= 1 && r.body.stars <= 5, `stars 在 1-5，实际 ${r.body.stars}`);
  });

  await check('手动调星级', async () => {
    const r = await api.post(`/api/agent-profiles/${pid}/rating`, { rating: 5 });
    assertStatus(r, 200, '调星级');
    assertEq(r.body.rating, 5, '星级=5');
    // 再查确认持久化（storedRating 是 DB 存储值，stars 是实时计算值）
    const g = await api.get(`/api/agent-profiles/${pid}/rating`);
    assertEq(g.body.storedRating, 5, 'storedRating=5');
  });

  await check('越界星级被拒', async () => {
    const r = await api.post(`/api/agent-profiles/${pid}/rating`, { rating: 6 });
    assert(r.status >= 400, `星级 6 应失败，实际 ${r.status}`);
  });

  await check('批量重算评级', async () => {
    const r = await api.post('/api/agent-profiles/rating/recalculate', {});
    assertStatus(r, 200, '批量重算');
    assert(typeof r.body.recalculated === 'number', '有 recalculated 计数');
  });
});

const r3 = await runSuite('B2B 外包决策树', async (check) => {
  const { companyId: coA } = await setupCompany(uname('b2b-A'));
  const { companyId: coB } = await setupCompany(uname('b2b-B'));

  await check('dispatch recruit 路径（自动招临时工）', async () => {
    const r = await api.post(`/api/companies/${coA}/outsource/dispatch`, {
      title: '冒烟外包', brief: '需要稀有能力',
      requiredCapabilityIds: [uname('rare-cap')],
      autoDecide: true,
    });
    assertStatus(r, 200, 'dispatch');
    // 无内部能力 + 无乙方有此能力 → recruit
    assertEq(r.body.decision.path, 'recruit', `应 recruit，实际 ${r.body.decision.path}`);
    assert(!!r.body.decision.tempAgentId, '有 tempAgentId');
  });

  await check('列出甲方契约（source）', async () => {
    const r = await api.get(`/api/companies/${coA}/outsource/contracts?role=source`);
    assertStatus(r, 200, 'source 契约');
    assert(Array.isArray(r.body), '返回数组');
  });

  await check('列出乙方契约（target）', async () => {
    const r = await api.get(`/api/companies/${coB}/outsource/contracts?role=target`);
    assertStatus(r, 200, 'target 契约');
    assert(Array.isArray(r.body), '返回数组');
  });
});

const r4 = await runSuite('B2B 外包契约全流程', async (check) => {
  const { companyId: coA, agentId: agentA } = await setupCompany(uname('contract-A'));
  const { companyId: coB, agentId: agentB } = await setupCompany(uname('contract-B'));
  const { projectId } = await setupProject(coA, agentA, uname('contract-proj'));

  let contractId;
  await check('显式指定乙方创建契约', async () => {
    const r = await api.post(`/api/companies/${coA}/outsource/dispatch`, {
      sourceProjectId: projectId,
      title: '契约测试', brief: '外包给指定乙方',
      vendorCompanyId: coB,
      autoDecide: false,
    });
    assertStatus(r, 201, '创建契约');
    contractId = r.body.contract.id;
    assertEq(r.body.contract.state, 'pending', '初始 pending');
  });

  await check('乙方接受契约', async () => {
    const r = await api.post(`/api/outsource/contracts/${contractId}/accept`, { vendorLiaisonAgentId: agentB });
    assertStatus(r, 200, '接受');
    assertEq(r.body.contract.state, 'in_progress', '接受后 in_progress');
    assert(!!r.body.task, '创建了承接任务');
    // 接受后创建了承接任务
    assert(!!r.body.contract.outsourcedTaskId, '有 outsourcedTaskId');
  });

  await check('契约详情可查', async () => {
    const r = await api.get(`/api/outsource/contracts/${contractId}`);
    assertStatus(r, 200, '契约详情');
    assertEq(r.body.id, contractId, 'id 一致');
    assertEq(r.body.state, 'in_progress', '接受后 in_progress');
  });

  await check('取消契约（非终态可取消）', async () => {
    const r = await api.post(`/api/outsource/contracts/${contractId}/cancel`, {});
    assertStatus(r, 200, '取消');
    assertEq(r.body.contract.state, 'cancelled', 'cancelled');
  });
});

totalPass = r1.pass + r2.pass + r3.pass + r4.pass;
totalFail = r1.fail + r2.fail + r3.fail + r4.fail;
console.log(`\n═══ 冒烟测试 5 总计：${totalPass}/${totalPass + totalFail} passed ═══`);
if (totalFail > 0) process.exit(1);
