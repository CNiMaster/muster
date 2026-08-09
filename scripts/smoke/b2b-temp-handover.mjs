/**
 * B2B 外包 + 临时工 + 权限委托 + 离职交接 冒烟测试。
 * 需先 npm run dev，然后 node scripts/smoke/b2b-temp-handover.mjs。
 *
 * 覆盖批次 A/B/C 的真实 HTTP 链路：
 *   1. 建两个公司（甲方游戏 + 乙方设计）
 *   2. B2B 外包决策树 dispatch（recruit 路径自动招临时工）
 *   3. 临时工转正 / 评级查询
 *   4. 权限委托链（申请 → 上级审批）
 *   5. 审计日志（权限模板 seed + 产物审计）
 *   6. 离职交接四阶段（创建 → 指定接手人 → 接收 → 完成）
 */
const BASE = process.env.MUSTER_API ?? 'http://127.0.0.1:3456';
let pass = 0, fail = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); pass++; results.push(`✓ ${name}`); }
  catch (e) { fail++; results.push(`✗ ${name}: ${e.message}`); }
}
const api = {
  get: (p) => fetch(`${BASE}${p}`).then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json() })),
  post: (p, data) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) }).then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json() })),
  patch: (p, data) => fetch(`${BASE}${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) }).then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json() })),
};

// ── 前置：建公司 + 员工 ──────────────────────────────────────────────────
let companyA, companyB, agentA, agentB, projectA;
await check('建甲方公司', async () => {
  const r = await api.post('/api/companies', { name: `冒烟甲方-${Date.now()}`, kind: 'general' });
  if (r.status !== 201) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
  companyA = r.body.id;
});
await check('建乙方公司', async () => {
  const r = await api.post('/api/companies', { name: `冒烟乙方-${Date.now()}`, kind: 'consulting' });
  if (r.status !== 201) throw new Error(`status ${r.status}`);
  companyB = r.body.id;
});
await check('甲方建项目（active）', async () => {
  const r = await api.post(`/api/companies/${companyA}/projects`, { name: '冒烟外包项目' });
  if (r.status !== 201) throw new Error(`status ${r.status}`);
  projectA = r.body.id;
  // 直接激活（跳过准备流程）
  await api.patch(`/api/projects/${projectA}`, { state: 'active' });
});
await check('甲方招临时工作为负责人（tempRecruit 豁免，off 态可招）', async () => {
  const r = await api.post(`/api/companies/${companyA}/employees/temp`, {
    role: 'lead',
    responsibilities: '冒烟负责人',
  });
  if (r.status !== 201) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
  agentA = r.body.agentId;
  // 设为第一负责人（off 态可改）
  const p = await api.patch(`/api/companies/${companyA}`, { firstAgentId: agentA });
  if (p.status !== 200) throw new Error(`设负责人失败 ${p.status}`);
});
await check('甲方 clock-in', async () => {
  const r = await api.post(`/api/companies/${companyA}/clock-in`, {});
  if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
});
await check('乙方招临时工作为负责人 + clock-in', async () => {
  const r = await api.post(`/api/companies/${companyB}/employees/temp`, { role: 'lead', responsibilities: '乙方负责人' });
  if (r.status !== 201) throw new Error(`status ${r.status}`);
  agentB = r.body.agentId;
  await api.patch(`/api/companies/${companyB}`, { firstAgentId: agentB });
  await api.post(`/api/companies/${companyB}/clock-in`, {});
});

// ── 批次 A：B2B 外包决策树 + 临时工 ──────────────────────────────────────
await check('A1: B2B dispatch（recruit 路径自动招临时工）', async () => {
  const r = await api.post(`/api/companies/${companyA}/outsource/dispatch`, {
    title: '冒烟外包任务',
    brief: '需要设计素材',
    requiredCapabilityIds: ['smoke-test-cap-nonexistent'],
    autoDecide: true,
  });
  if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
  // recruit 路径（无内部无乙方有此能力）应自动招临时工
  if (r.body.decision?.path !== 'recruit') {
    throw new Error(`期望 recruit 路径，实际 ${r.body.decision?.path}`);
  }
  if (!r.body.decision?.tempAgentId) throw new Error('recruit 未返回 tempAgentId');
});

await check('A2: 手动招临时工', async () => {
  const r = await api.post(`/api/companies/${companyA}/employees/temp`, {
    role: 'smoke-designer',
    responsibilities: '冒烟测试临时工',
  });
  if (r.status !== 201) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
  if (!r.body.agentId) throw new Error('无 agentId');
  if (!r.body.isNewProfile) throw new Error('应为新建 profile');
});

await check('A3: 列出临时工', async () => {
  const r = await api.get(`/api/companies/${companyA}/employees/temp`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!Array.isArray(r.body)) throw new Error('应返回数组');
});

await check('A4: 评级明细查询', async () => {
  // agentA 是临时工（is_temp_only=1），不在人才市场列表；用其 profileId 查评级
  const agentDetail = await api.get(`/api/companies/${companyA}/agents/${agentA}`);
  const pid = agentDetail.body.profileId;
  const r = await api.get(`/api/agent-profiles/${pid}/rating`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (typeof r.body.stars !== 'number') throw new Error('无 stars');
});

await check('A5: 手动调星级', async () => {
  const agentDetail = await api.get(`/api/companies/${companyA}/agents/${agentA}`);
  const pid = agentDetail.body.profileId;
  const r = await api.post(`/api/agent-profiles/${pid}/rating`, { rating: 4 });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (r.body.rating !== 4) throw new Error('星级未更新');
});

// ── 批次 B：权限委托链 + 审计 ────────────────────────────────────────────
await check('B1: 权限模板 seed（三档）', async () => {
  const r = await api.post('/api/permission-templates/seed');
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!r.body.manager || !r.body.employee || !r.body.temp) throw new Error('缺模板');
});

await check('B2: 权限变更申请', async () => {
  const r = await api.post(`/api/companies/${companyA}/permission-changes`, {
    requesterEmployeeId: agentA,
    requestedScope: 'temp',
    reason: '冒烟测试申请',
    requestedAction: 'write-file',
    targetPathPrefix: 'docs/',
  });
  if (r.status !== 201) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
  if (r.body.state !== 'pending') throw new Error('应 pending');
  if (!r.body.approverEmployeeId) throw new Error('应自动路由审批人');
});

await check('B3: 列出待审批', async () => {
  const r = await api.get(`/api/companies/${companyA}/permission-changes?role=approver&employeeId=${agentA}`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!Array.isArray(r.body)) throw new Error('应返回数组');
});

await check('B4: 项目审计日志（空）', async () => {
  const r = await api.get(`/api/projects/${projectA}/audit-log`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!Array.isArray(r.body)) throw new Error('应返回数组');
});

// ── 批次 C：离职交接四阶段 ────────────────────────────────────────────────
let tempAgentForHandover, handoverId;
await check('C1: 招一个临时工用于交接测试', async () => {
  const r = await api.post(`/api/companies/${companyA}/employees/temp`, {
    role: 'handover-test',
  });
  if (r.status !== 201) throw new Error(`status ${r.status}`);
  tempAgentForHandover = r.body.agentId;
});

await check('C2: 创建交接记录（drafting）', async () => {
  const r = await api.post(`/api/companies/${companyA}/handover`, {
    departingEmployeeId: tempAgentForHandover,
  });
  if (r.status !== 201) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
  handoverId = r.body.id;
  if (r.body.state !== 'drafting') throw new Error('应 drafting');
});

await check('C3: 更新交接内容', async () => {
  const r = await api.patch(`/api/handover/${handoverId}/content`, {
    handoverNote: '冒烟交接记录',
    lessons: ['经验1'],
    pendingWork: [{ title: '待办1', detail: '细节' }],
  });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (r.body.handoverNote !== '冒烟交接记录') throw new Error('内容未更新');
});

await check('C4: 指定接手人（→ awaiting）', async () => {
  const r = await api.post(`/api/handover/${handoverId}/assign`, {
    receiverEmployeeId: agentA,
  });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (r.body.state !== 'awaiting') throw new Error('应 awaiting');
});

await check('C5: 开始接收（→ receiving）', async () => {
  const r = await api.post(`/api/handover/${handoverId}/receive`, {});
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (r.body.state !== 'receiving') throw new Error('应 receiving');
});

await check('C6: 完成交接（→ completed，离职生效）', async () => {
  const r = await api.post(`/api/handover/${handoverId}/complete`, {});
  if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
  if (r.body.state !== 'completed') throw new Error('应 completed');
  if (!r.body.completedAt) throw new Error('应有 completedAt');
});

await check('C7: 列出公司交接记录', async () => {
  const r = await api.get(`/api/companies/${companyA}/handover`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!Array.isArray(r.body)) throw new Error('应返回数组');
});

// ── 外包契约基础（B2B）──────────────────────────────────────────────────
await check('D1: 列出甲方外包契约', async () => {
  const r = await api.get(`/api/companies/${companyA}/outsource/contracts?role=source`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!Array.isArray(r.body)) throw new Error('应返回数组');
});

await check('D2: 列出乙方外包契约', async () => {
  const r = await api.get(`/api/companies/${companyB}/outsource/contracts?role=target`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
});

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log(results.join('\n'));
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.error(`❌ ${fail} 项失败`);
  process.exit(1);
} else {
  console.log('✅ 全部通过');
}
