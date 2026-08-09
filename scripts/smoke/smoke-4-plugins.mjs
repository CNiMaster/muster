/**
 * 冒烟测试 4：Plugin 治理（opt-out 三态 / 公司独占 / effective 计算）。
 */
import { api, assert, assertEq, assertStatus, uname, setupCompany, runSuite } from './_helpers.mjs';

let totalPass = 0, totalFail = 0;

const r1 = await runSuite('Plugin 基础 CRUD', async (check) => {
  await check('GET plugins 含 builtin（skill/tool/bridge）', async () => {
    const r = await api.get('/api/plugins');
    assertStatus(r, 200, 'plugins');
    const kinds = new Set(r.body.map(p => p.kind));
    assert(kinds.has('skill') || kinds.has('tool') || kinds.has('bridge-action'), `含 builtin kind，实际 ${[...kinds]}`);
  });
  await check('安装 stdio MCP plugin', async () => {
    const r = await api.post('/api/plugins', {
      name: uname('mcp'), kind: 'mcp-server',
      source: { kind: 'builtin' }, scope: { level: 'platform' },
      manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'echo', args: ['hi'] } },
    });
    assertStatus(r, 201, '安装 MCP');
    assert(!!r.body.id, '有 plugin id');
  });
});

const r2 = await runSuite('opt-out 治理：三态', async (check) => {
  const { companyId } = await setupCompany(uname('plug-co'));
  // 安装一个平台级 MCP
  const inst = await api.post('/api/plugins', {
    name: uname('plat-mcp'), kind: 'mcp-server',
    source: { kind: 'builtin' }, scope: { level: 'platform' },
    manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'echo' } },
  });
  const pluginId = inst.body.id;

  await check('default 态：effective 含该插件', async () => {
    const r = await api.get(`/api/plugins/companies/${companyId}/plugins/effective`);
    assertStatus(r, 200, 'effective');
    const found = r.body.find(p => p.id === pluginId);
    assert(!!found, 'effective 含平台插件');
    // companyDecision 应是 default 或 enabled（无覆盖行 = default）
    assert(['default', 'enabled'].includes(found.companyDecision), `decision 应 default/enabled，实际 ${found.companyDecision}`);
  });

  await check('上班期间 disable 被拒（org-lock）', async () => {
    const r = await api.post(`/api/plugins/companies/${companyId}/plugins/${pluginId}/disable`);
    assert(r.status === 423 || r.status === 409, `上班 disable 应锁，实际 ${r.status}`);
  });

  // 下班后操作
  await api.post(`/api/companies/${companyId}/clock-out`, {});

  await check('disable 后 effective 排除该插件', async () => {
    const r = await api.post(`/api/plugins/companies/${companyId}/plugins/${pluginId}/disable`);
    assertStatus(r, 200, 'disable');
    const eff = await api.get(`/api/plugins/companies/${companyId}/plugins/effective`);
    const found = eff.body.find(p => p.id === pluginId);
    assert(!found, 'disabled 插件不应在 effective 列表');
  });

  await check('enable 后恢复 effective', async () => {
    const r = await api.post(`/api/plugins/companies/${companyId}/plugins/${pluginId}/enable`);
    assertStatus(r, 200, 'enable');
    const eff = await api.get(`/api/plugins/companies/${companyId}/plugins/effective`);
    const found = eff.body.find(p => p.id === pluginId);
    assert(!!found, 'enable 后恢复 effective');
  });
});

const r3 = await runSuite('公司独占插件', async (check) => {
  const { companyId, agentId } = await setupCompany(uname('excl-co'));
  const { companyId: co2 } = await setupCompany(uname('excl-other'));
  // 下班后安装独占
  await api.post(`/api/companies/${companyId}/clock-out`, {});

  await check('安装公司独占插件', async () => {
    const r = await api.post(`/api/plugins/companies/${companyId}/plugins/exclusive`, {
      name: uname('excl'), kind: 'skill',
      source: { kind: 'company', companyId },
      manifest: { kind: 'skill', skill: { body: '专属能力' } },
    });
    assertStatus(r, 201, '独占安装');
    assert(!!r.body.id, '有 id');
  });
  await check('company-scoped 列表', async () => {
    const r = await api.get(`/api/plugins/company-scoped/${companyId}`);
    assertStatus(r, 200, 'company-scoped');
    assert(Array.isArray(r.body), '返回数组');
  });
});

totalPass = r1.pass + r2.pass + r3.pass;
totalFail = r1.fail + r2.fail + r3.fail;
console.log(`\n═══ 冒烟测试 4 总计：${totalPass}/${totalPass + totalFail} passed ═══`);
if (totalFail > 0) process.exit(1);
