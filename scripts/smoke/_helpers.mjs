/**
 * 冒烟测试共享辅助：HTTP 客户端 + 断言 + 公司/员工/项目 setup 工厂。
 *
 * 所有冒烟模块 import { api, assert, setupCompany } from './_helpers.mjs'
 */
const BASE = process.env.MUSTER_API ?? 'http://127.0.0.1:3456';

export const api = {
  get: (p) => fetch(`${BASE}${p}`).then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) })),
  post: (p, data) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) }).then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) })),
  patch: (p, data) => fetch(`${BASE}${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) }).then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) })),
  put: (p, data) => fetch(`${BASE}${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) }).then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) })),
  del: (p) => fetch(`${BASE}${p}`, { method: 'DELETE' }).then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) })),
};

/** 断言：condition 为 false 时抛错。 */
export function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? '断言失败');
}
export function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg ?? ''} 期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}`);
}
export function assertStatus(r, expected, msg) {
  if (r.status !== expected) throw new Error(`${msg ?? ''} 期望 HTTP ${expected} 实际 ${r.status}: ${JSON.stringify(r.body)}`);
}

let _seq = 0;
/** 唯一名称（避免重名冲突）。 */
export function uname(prefix = 't') {
  return `${prefix}-${Date.now()}-${++_seq}`;
}

/**
 * setupCompany：创建公司 + 招临时工作为负责人 + clock-in。
 * 返回 { companyId, agentId, profileId }。
 * 临时工招聘豁免 org lock，公司保持 online，可立即操作。
 */
export async function setupCompany(name) {
  const r = await api.post('/api/companies', { name: name ?? uname('公司'), kind: 'general' });
  assertStatus(r, 201, '建公司');
  const companyId = r.body.id;
  // 招临时工作为负责人（off 态可招，tempRecruit 豁免）
  const ar = await api.post(`/api/companies/${companyId}/employees/temp`, { role: 'lead', responsibilities: '负责人' });
  assertStatus(ar, 201, '招负责人');
  const agentId = ar.body.agentId;
  const profileId = ar.body.profileId;
  // 设为第一负责人 + clock-in
  await api.patch(`/api/companies/${companyId}`, { firstAgentId: agentId });
  await api.post(`/api/companies/${companyId}/clock-in`, {});
  return { companyId, agentId, profileId };
}

/**
 * setupProject：创建项目 + 走完准备流程到 active + 确认 launch。
 * 返回 { projectId, projectTaskId }。
 */
export async function setupProject(companyId, agentId, name) {
  const r = await api.post(`/api/companies/${companyId}/projects`, { name: name ?? uname('项目') });
  assertStatus(r, 201, '建项目');
  const projectId = r.body.id;
  // 写 readiness（合并 settings）
  const onboarding = {
    draft: { goal: '冒烟目标', audience: '用户', constraints: '' },
    research: { summary: '冒烟调研', candidateSkills: ['web-research'], candidateTools: [] },
    equipment: { enabledPlugins: ['plg_smoke'], missingCapabilities: [] },
    staffing: { employeeIds: [agentId] },
    notes: '',
  };
  await api.patch(`/api/projects/${projectId}`, { settings: { onboarding } });
  // 逐阶段前进到 active
  for (const phase of ['researching', 'equipping', 'staffing', 'ready', 'active']) {
    const tr = await api.patch(`/api/projects/${projectId}`, { state: phase });
    assertStatus(tr, 200, `阶段→${phase}`);
  }
  // 创建 project-task + discover + confirm-launch
  const pt = await api.post(`/api/projects/${projectId}/project-tasks`, { title: uname('工作单') });
  assertStatus(pt, 201, '建 project-task');
  const projectTaskId = pt.body.id;
  // discover-capabilities（填充 discovery，confirm 前置条件）
  const launchBrief = { expectedOutcome: '冒烟验收标准', externalResearchNeeds: [], needsVisualConfirmation: false, visualReferences: [] };
  const dc = await api.post(`/api/projects/${projectId}/project-tasks/${projectTaskId}/discover-capabilities`, { launchBrief });
  assertStatus(dc, 200, 'discover-capabilities');
  // confirm-launch
  const cl = await api.post(`/api/projects/${projectId}/project-tasks/${projectTaskId}/confirm-launch`, { launchBrief });
  assertStatus(cl, 200, 'confirm-launch');
  return { projectId, projectTaskId };
}

/**
 * 运行一个测试套件，打印结果，返回 {pass, fail}。
 */
export async function runSuite(name, fn) {
  let pass = 0, fail = 0;
  const results = [];
  const check = async (title, testFn) => {
    try { await testFn(); pass++; results.push(`  ✓ ${title}`); }
    catch (e) { fail++; results.push(`  ✗ ${title}: ${e.message}`); }
  };
  console.log(`\n▶ ${name}`);
  try {
    await fn(check);
  } catch (e) {
    fail++; results.push(`  ✗ 套件级错误: ${e.message}`);
  }
  console.log(results.join('\n'));
  console.log(`  ${pass}/${pass + fail} passed`);
  return { pass, fail };
}
