const BASE = process.env.MUSTER_API ?? 'http://127.0.0.1:3456';
let pass = 0, fail = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); pass++; results.push(`✓ ${name}`); }
  catch (e) { fail++; results.push(`✗ ${name}: ${e.message}`); }
}
const api = {
  get: (p) => fetch(`${BASE}${p}`).then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json() })),
  post: (p, data) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json() })),
  patch: (p, data) => fetch(`${BASE}${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json() })),
};

await check('健康检查 200', async () => {
  const r = await api.get('/api/health');
  if (r.status !== 200 || r.body.status !== 'ok') throw new Error(`status=${r.status}`);
});

let companyId;
await check('建公司', async () => {
  const r = await api.post('/api/workbench', { name: `冒烟公司-${Date.now()}`, kind: 'general' });
  if (r.status !== 201) throw new Error(`status ${r.status}`);
  companyId = r.body.id;
});

let projectId;
await check('B2 建项目默认 drafting', async () => {
  const r = await api.post(`/api/projects`, { name: '冒烟项目' });
  if (r.status !== 201) throw new Error(`status ${r.status}`);
  projectId = r.body.id;
  if (r.body.state !== 'drafting') throw new Error(`state=${r.body.state}`);
});

await check('B4 写 readiness（PATCH 部分更新不覆盖 name）', async () => {
  const r = await api.patch(`/api/projects/${projectId}`, {
    settings: { onboarding: { draft: { goal: '冒烟目标', audience: '用户', constraints: '' }, research: { summary: '冒烟调研', candidateSkills: ['web-research'], candidateTools: [] }, equipment: { enabledPlugins: ['plg_smoke'], missingCapabilities: [] }, staffing: { employeeIds: ['dummy'] }, notes: '' } },
  });
  if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
  if (r.body.name !== '冒烟项目') throw new Error('name 被覆盖为 undefined（部分更新 bug）');
  if (r.body.settings?.onboarding?.draft?.goal !== '冒烟目标') throw new Error('readiness 未落库');
});

await check('B4 drafting→researching 通过产物校验', async () => {
  const r = await api.patch(`/api/projects/${projectId}`, { state: 'researching' });
  if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
});

await check('B2 非法跃迁 drafting→active 被拦 (409)', async () => {
  const r = await api.post(`/api/projects`, { name: '非法跃迁' });
  const bad = await api.patch(`/api/projects/${r.body.id}`, { state: 'active' });
  if (bad.status !== 409) throw new Error(`期望 409, 实际 ${bad.status}`);
});

await check('B1/B3a listPlugins 含 builtin', async () => {
  const r = await api.get('/api/plugins');
  const kinds = new Set(r.body.map(p => p.kind));
  if (!kinds.has('skill') && !kinds.has('tool')) throw new Error(`缺少 builtin: ${[...kinds]}`);
});

let mcpPluginId;
await check('B3a 安装 stdio MCP plugin', async () => {
  const r = await api.post('/api/plugins', {
    name: '冒烟 MCP', kind: 'mcp-server',
    source: { kind: 'company', companyId }, scope: { level: 'company', companyId },
    manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'echo', args: ['hi'] } },
  });
  if (r.status !== 201) throw new Error(`status ${r.status}`);
  mcpPluginId = r.body.id;
});

await check('B6 安装 SSE MCP plugin（headers 落库）', async () => {
  const r = await api.post('/api/plugins', {
    name: '冒烟 SSE', kind: 'mcp-server',
    source: { kind: 'company', companyId }, scope: { level: 'company', companyId },
    manifest: { kind: 'mcp-server', mcp: { transport: 'sse', url: 'http://example.com/sse', headers: { Authorization: 'Bearer x' } } },
  });
  if (r.status !== 201) throw new Error(`status ${r.status}`);
  const got = await api.get(`/api/plugins/${r.body.id}`);
  if (got.body.manifest.mcp.headers?.Authorization !== 'Bearer x') throw new Error('headers 未落库');
});

await check('B3a 公司 off 时启用 plugin（正向）', async () => {
  const r = await api.post(`/api/plugins/companies/${companyId}/plugins/${mcpPluginId}/enable`, {});
  if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
  const en = await api.get(`/api/plugins/companies/${companyId}/plugins/enabled`);
  if (!en.body.includes(mcpPluginId)) throw new Error('未在启用列表');
});

await check('B3b marketplace local 检索', async () => {
  const r = await api.get('/api/plugins/marketplace/search?q=browser&github=0');
  if (r.status !== 200 || !Array.isArray(r.body.local)) throw new Error(`status ${r.status}`);
});

await check('B5 走完准备流程到 active', async () => {
  for (const target of ['equipping', 'staffing', 'ready', 'active']) {
    const r = await api.patch(`/api/projects/${projectId}`, { state: target });
    if (r.status !== 200) throw new Error(`${target}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const final = await api.get(`/api/projects/${projectId}`);
  if (final.body.state !== 'active') throw new Error(`state=${final.body.state}`);
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
