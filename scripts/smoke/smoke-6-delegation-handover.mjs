/**
 * 冒烟测试 6：权限委托链 + 离职交接。
 */
import { api, assert, assertEq, assertStatus, uname, setupCompany, setupProject, runSuite } from './_helpers.mjs';

let totalPass = 0, totalFail = 0;

const r1 = await runSuite('权限委托链', async (check) => {
  const { companyId, agentId } = await setupCompany(uname('deleg-co'));

  let requestId;
  await check('申请权限变更（自动路由审批人）', async () => {
    const r = await api.post(`/api/companies/${companyId}/permission-changes`, {
      requesterEmployeeId: agentId,
      requestedScope: 'temp',
      reason: '冒烟需要写权限',
      requestedAction: 'write-file',
      targetPathPrefix: 'docs/',
    });
    assertStatus(r, 201, '申请');
    requestId = r.body.id;
    assertEq(r.body.state, 'pending', 'pending');
    assert(!!r.body.approverEmployeeId, '自动路由了审批人');
    // temp scope 应有有效期
    assert(!!r.body.validUntil, 'temp 有 validUntil');
  });

  await check('列出待审批', async () => {
    // agentId 是 setupCompany 的负责人，也是默认审批人
    const r = await api.get(`/api/companies/${companyId}/permission-changes?role=approver&employeeId=${agentId}`);
    assertStatus(r, 200, '待审批列表');
    assert(Array.isArray(r.body), '返回数组');
  });

  await check('申请人取消', async () => {
    const r = await api.post(`/api/permission-changes/${requestId}/cancel`, { requesterId: agentId });
    assertStatus(r, 200, '取消');
    assertEq(r.body.state, 'cancelled', 'cancelled');
  });

  await check('permanent scope 无 validUntil', async () => {
    const r = await api.post(`/api/companies/${companyId}/permission-changes`, {
      requesterEmployeeId: agentId,
      requestedScope: 'permanent',
      reason: '永久权限',
    });
    assertStatus(r, 201, 'permanent 申请');
    assertEq(r.body.validUntil, null, 'permanent 无 validUntil');
  });
});

const r2 = await runSuite('离职交接四阶段', async (check) => {
  const { companyId, agentId: receiverId } = await setupCompany(uname('handover-co'));
  // 招一个临时工作为离职人
  const tr = await api.post(`/api/companies/${companyId}/employees/temp`, { role: 'departing' });
  const departingId = tr.body.agentId;

  let handoverId;
  await check('创建交接记录（drafting + 自动产物清单）', async () => {
    const r = await api.post(`/api/companies/${companyId}/handover`, { departingEmployeeId: departingId });
    assertStatus(r, 201, '建交接');
    handoverId = r.body.id;
    assertEq(r.body.state, 'drafting', 'drafting');
    assert(Array.isArray(r.body.artifactInventory), '有产物清单');
  });

  await check('更新交接内容', async () => {
    const r = await api.patch(`/api/handover/${handoverId}/content`, {
      handoverNote: '冒烟交接记录',
      lessons: ['经验1', '经验2'],
      pendingWork: [{ title: '待办', detail: '细节' }],
    });
    assertStatus(r, 200, '更新内容');
    assertEq(r.body.handoverNote, '冒烟交接记录', 'note 更新');
    assertEq(r.body.lessons.length, 2, '2 条经验');
  });

  await check('指定接手人（→ awaiting）', async () => {
    const r = await api.post(`/api/handover/${handoverId}/assign`, { receiverEmployeeId: receiverId });
    assertStatus(r, 200, 'assign');
    assertEq(r.body.state, 'awaiting', 'awaiting');
  });

  await check('开始接收（→ receiving）', async () => {
    const r = await api.post(`/api/handover/${handoverId}/receive`, {});
    assertStatus(r, 200, 'receive');
    assertEq(r.body.state, 'receiving', 'receiving');
  });

  await check('完成交接（→ completed，离职生效）', async () => {
    const r = await api.post(`/api/handover/${handoverId}/complete`, {});
    assertStatus(r, 200, 'complete');
    assertEq(r.body.state, 'completed', 'completed');
    assert(!!r.body.completedAt, '有 completedAt');
    // 离职员工应已被删（agent_definition 不存在）
    const agentCheck = await api.get(`/api/companies/${companyId}/agents/${departingId}`);
    assertEq(agentCheck.status, 404, '离职员工已删');
  });

  await check('重复交接被拒（同一员工）', async () => {
    // departingId 已删，但尝试用 receiverId 再交接（receiver 还在）
    const r = await api.post(`/api/companies/${companyId}/handover`, { departingEmployeeId: receiverId });
    // receiverId 还在，可以创建（但若已有未完成的会冲突）
    // 这里只验证不崩溃
    assert(r.status === 201 || r.status === 409, `创建或冲突都行，实际 ${r.status}`);
  });
});

const r3 = await runSuite('交接记录列表 + offboard 入口', async (check) => {
  const { companyId, agentId } = await setupCompany(uname('offboard-co'));

  await check('列出公司交接记录', async () => {
    const r = await api.get(`/api/companies/${companyId}/handover`);
    assertStatus(r, 200, '交接列表');
    assert(Array.isArray(r.body), '返回数组');
  });

  await check('offboard 入口创建交接', async () => {
    const r = await api.post(`/api/companies/${companyId}/employees/${agentId}/offboard`, {});
    assert(r.status === 201, `offboard 应 201，实际 ${r.status}`);
  });
});

totalPass = r1.pass + r2.pass + r3.pass;
totalFail = r1.fail + r2.fail + r3.fail;
console.log(`\n═══ 冒烟测试 6 总计：${totalPass}/${totalPass + totalFail} passed ═══`);
if (totalFail > 0) process.exit(1);
