/**
 * 冒烟测试 1：工作台 + 员工 + 项目 + 任务 核心流程。
 *
 * 验证业务逻辑正确性（不只是 HTTP 200）：
 * - 工作台单例（GET /api/workbench 幂等，off 态）+ 状态机（off→online→off）
 * - 员工 CRUD + org-lock（上班不能改员工）
 * - 项目状态机（drafting→...→active, readiness 门禁, 非法跃迁拦截）
 * - 任务创建双门禁（项目 active + launch confirmed）+ 生命周期
 *
 * 公司退役批次C：不再建公司，一律走隐式单例工作台。
 *
 * 运行：node scripts/smoke/smoke-1-core.mjs   （可重复运行）
 */
import { api, assert, assertEq, assertStatus, uname, setupCompany, setupProject, runSuite } from './_helpers.mjs';

let totalPass = 0, totalFail = 0;

// ── 工作台单例 + 生命周期 ──────────────────────────────────────────────────
const r1 = await runSuite('工作台单例 + 生命周期', async (check) => {
  let co;
  await check('GET /api/workbench 幂等创建默认工作台：general/off/blocking', async () => {
    const r = await api.get('/api/workbench');
    assertStatus(r, 200, '取默认工作台');
    co = r.body;
    assertEq(co.state, 'off', '默认 state');
    assertEq(co.reviewMode, 'blocking', '默认 reviewMode');
    assertEq(co.archivedAt, null, 'archivedAt');
    const r2 = await api.get('/api/workbench');
    assertEq(r2.body.id, co.id, '幂等：同一工作台');
  });
  await check('clock-in 无 firstAgent 被拒（400）', async () => {
    const ci = await api.post(`/api/workbench/clock-in`, {});
    assert(ci.status === 400, `无负责人 clock-in 应 400，实际 ${ci.status}`);
  });
  await check('clock-in 后 state=online', async () => {
    await setupCompany(uname('online-co'));
    const r = await api.get(`/api/workbench`);
    assertEq(r.body.state, 'online', 'clock-in 后');
  });
  await check('clock-out → off（无运行任务）', async () => {
    await setupCompany(uname('clockout'));
    const r = await api.post(`/api/workbench/clock-out`, {});
    assertStatus(r, 200, 'clock-out');
    const g = await api.get(`/api/workbench`);
    assertEq(g.body.state, 'off', 'clock-out 后');
  });
});

// ── 员工 CRUD + org-lock ─────────────────────────────────────────────────
const r2 = await runSuite('员工 CRUD + org-lock', async (check) => {
  const { companyId, agentId } = await setupCompany(uname('emp-co'));
  await check('GET agents 列表非空', async () => {
    const r = await api.get(`/api/agents`);
    assertStatus(r, 200, 'agents 列表');
    assert(r.body.length >= 1, '至少 1 个员工');
  });
  await check('GET agent 详情有 profileId', async () => {
    const r = await api.get(`/api/agents/${agentId}`);
    assertStatus(r, 200, 'agent 详情');
    assert(!!r.body.profileId, '有 profileId');
  });
  await check('上班期间删员工被拒（org-lock）', async () => {
    const r = await api.del(`/api/agents/${agentId}`);
    assert(r.status === 423 || r.status === 409, `上班删员工应锁，实际 ${r.status}`);
  });
  await check('下班后删员工成功', async () => {
    await api.post(`/api/workbench/clock-out`, {});
    const r = await api.del(`/api/agents/${agentId}`);
    assertStatus(r, 204, '下班删员工');
  });
  await check('人才市场列表过滤临时工（is_temp_only）', async () => {
    const r = await api.get('/api/agent-profiles');
    assertStatus(r, 200, '人才市场');
    // setupCompany 招的临时工 is_temp_only=1，应被过滤
    const allTempOnly = r.body.every(p => p.isTempOnly === 0 || p.isTempOnly === undefined);
    assert(allTempOnly, '人才市场不应含 is_temp_only=1');
  });
});

// ── 项目状态机 + readiness 门禁 ───────────────────────────────────────────
const r3 = await runSuite('项目状态机 + readiness 门禁', async (check) => {
  const { companyId } = await setupCompany(uname('proj-co'));
  await check('建项目默认 drafting', async () => {
    const r = await api.post(`/api/projects`, { name: uname('proj') });
    assertStatus(r, 201, '建项目');
    assertEq(r.body.state, 'drafting', '默认 drafting');
  });
  await check('非法跃迁 drafting→active 被拒', async () => {
    const r = await api.post(`/api/projects`, { name: uname('bad') });
    const pid = r.body.id;
    const tr = await api.patch(`/api/projects/${pid}`, { state: 'active' });
    assert(tr.status === 409 || tr.status === 400, `非法跃迁应失败，实际 ${tr.status}`);
  });
  await check('无 goal drafting→researching 被拒', async () => {
    const r = await api.post(`/api/projects`, { name: uname('nogoal') });
    const pid = r.body.id;
    const tr = await api.patch(`/api/projects/${pid}`, { state: 'researching' });
    assert(tr.status >= 400, `无 goal 前进应失败，实际 ${tr.status}`);
  });
  await check('完整准备流程到 active', async () => {
    // 先招一个 agent 作为 staffing
    const ar = await api.post(`/api/employees/temp`, { role: 'dev' });
    const aid = ar.body.agentId;
    const { projectId } = await setupProject(companyId, aid, uname('full'));
    const g = await api.get(`/api/projects/${projectId}`);
    assertEq(g.body.state, 'active', '准备流程后应 active');
  });
});

// ── 任务双门禁 + 生命周期 ────────────────────────────────────────────────
const r4 = await runSuite('任务双门禁 + 生命周期', async (check) => {
  const { companyId, agentId } = await setupCompany(uname('task-co'));
  await check('显式 projectTaskId 在非 active 项目被拒', async () => {
    const r = await api.post(`/api/projects`, { name: uname('tp') });
    const pid = r.body.id;
    // 在 drafting 项目建 project-task
    const pt = await api.post(`/api/projects/${pid}/project-tasks`, { title: 'pt' });
    const ptid = pt.body.id;
    // 显式传 projectTaskId → assertProjectActive 拦截
    const tr = await api.post(`/api/projects/${pid}/tasks`, { projectTaskId: ptid, title: 'x', assigneeAgentId: agentId });
    assert(tr.status >= 400, `非 active 建任务应失败，实际 ${tr.status}`);
  });
  await check('显式 projectTaskId 在 launch 未确认时被拒', async () => {
    const r = await api.post(`/api/projects`, { name: uname('tp2') });
    const pid = r.body.id;
    // 走完整准备流程到 active
    await api.patch(`/api/projects/${pid}`, { settings: { onboarding: { draft: { goal: 'g', audience: '', constraints: '' }, research: { summary: 's', candidateSkills: [], candidateTools: [] }, equipment: { enabledPlugins: [], missingCapabilities: [] }, staffing: { employeeIds: [agentId] }, notes: '' } } });
    for (const ph of ['researching','equipping','staffing','ready','active']) {
      await api.patch(`/api/projects/${pid}`, { state: ph });
    }
    // 建 project-task 但不 confirm-launch
    const pt = await api.post(`/api/projects/${pid}/project-tasks`, { title: 'pt2' });
    const ptid = pt.body.id;
    // 显式传 projectTaskId → assertProjectLaunchConfirmed 拦截
    const tr = await api.post(`/api/projects/${pid}/tasks`, { projectTaskId: ptid, title: 'x' });
    assert(tr.status >= 400, `launch 未确认建任务应失败，实际 ${tr.status}`);
  });
  await check('完整流程：建任务 → queued → cancel', async () => {
    const { projectId, projectTaskId } = await setupProject(companyId, agentId, uname('task-ok'));
    const tr = await api.post(`/api/projects/${projectId}/tasks`, { projectTaskId, title: '冒烟任务', assigneeAgentId: agentId });
    assertStatus(tr, 201, '建任务');
    assertEq(tr.body.state, 'queued', '默认 queued');
    const tid = tr.body.id;
    // cancel
    const cr = await api.post(`/api/tasks/${tid}/cancel`, {});
    assertStatus(cr, 200, 'cancel');
    const g = await api.get(`/api/tasks/${tid}`);
    assertEq(g.body.state, 'cancelled', 'cancel 后');
  });
  await check('跨公司 assignee 被拒', async () => {
    const { companyId: co2 } = await setupCompany(uname('other-co'));
    const { projectId, projectTaskId } = await setupProject(companyId, agentId, uname('cross'));
    // co2 的 agent 不存在（setupCompany 招的临时工），用一个不存在的 id
    const tr = await api.post(`/api/projects/${projectId}/tasks`, { projectTaskId, title: 'x', assigneeAgentId: 'ag_nonexistent' });
    assert(tr.status >= 400, `不存在 assignee 应失败，实际 ${tr.status}`);
  });
});

totalPass = r1.pass + r2.pass + r3.pass + r4.pass;
totalFail = r1.fail + r2.fail + r3.fail + r4.fail;
console.log(`\n═══ 冒烟测试 1 总计：${totalPass}/${totalPass + totalFail} passed ═══`);
if (totalFail > 0) process.exit(1);
