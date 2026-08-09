/**
 * 冒烟测试 3：执行器 + 权限 + 凭据 + 工具档案。
 */
import { api, assert, assertEq, assertStatus, uname, setupCompany, runSuite } from './_helpers.mjs';

let totalPass = 0, totalFail = 0;

const r1 = await runSuite('执行器 manifests + profiles', async (check) => {
  await check('GET manifests 非空', async () => {
    const r = await api.get('/api/executors/manifests');
    assertStatus(r, 200, 'manifests');
    assert(r.body.length >= 1, `至少 1 个 manifest，实际 ${r.body.length}`);
    // 验证有已知 manifest
    const ids = r.body.map(m => m.id);
    assert(ids.includes('claude-code-cli') || ids.includes('codex-cli'), '含已知 CLI');
  });
  await check('创建 executor profile', async () => {
    const r = await api.post('/api/executors/profiles', { name: uname('profile'), manifestId: 'claude-code-cli' });
    assertStatus(r, 201, '建 profile');
    assert(!!r.body.id, '有 id');
  });
  await check('GET profiles 列表', async () => {
    const r = await api.get('/api/executors/profiles');
    assertStatus(r, 200, 'profiles 列表');
    assert(Array.isArray(r.body), '返回数组');
  });
});

const r2 = await runSuite('权限策略 + 规则 + 审批', async (check) => {
  let policyId;
  await check('创建权限策略', async () => {
    const r = await api.post('/api/permissions/policies', { name: uname('policy'), approvalStrategy: 'ask-by-rule', scope: 'task' });
    assertStatus(r, 201, '建策略');
    policyId = r.body.id;
  });
  await check('GET policies 列表', async () => {
    const r = await api.get('/api/permissions/policies');
    assertStatus(r, 200, 'policies');
    assert(r.body.some(p => p.id === policyId), '列表含新建策略');
  });
  await check('添加权限规则', async () => {
    const r = await api.post(`/api/permissions/policies/${policyId}/rules`, { effect: 'allow', action: 'read-file', pathPrefix: 'docs/' });
    assertStatus(r, 201, '建规则');
    assert(!!r.body.id, '有 rule id');
  });
  await check('权限模板 seed 三档', async () => {
    const r = await api.post('/api/permission-templates/seed');
    assertStatus(r, 200, '模板 seed');
    assert(r.body.manager && r.body.employee && r.body.temp, '三档都有');
    // 幂等：再 seed 一次返回同 id
    const r2 = await api.post('/api/permission-templates/seed');
    assertEq(r2.body.manager, r.body.manager, 'manager 幂等');
  });
});

const r3 = await runSuite('凭据定义', async (check) => {
  await check('GET credentials 有默认种子', async () => {
    const r = await api.get('/api/credentials?category=llm&defaults=1');
    assertStatus(r, 200, 'credentials');
    // 启动时 seed 了 Anthropic/OpenAI/Google/DeepSeek
    assert(r.body.length >= 1, `至少 1 个凭据定义，实际 ${r.body.length}`);
  });
  await check('创建凭据定义', async () => {
    const r = await api.post('/api/credentials', { name: uname('cred'), credentialKey: 'SMOKE_TEST_KEY', kind: 'env', category: 'external-api', applicableExecutors: ['custom-cli'] });
    assertStatus(r, 201, '建凭据');
  });
});

const r4 = await runSuite('工具档案', async (check) => {
  await check('sync 扫描工具目录', async () => {
    const r = await api.get('/api/tools/sync');
    assertStatus(r, 200, 'sync');
    assert(typeof r.body.added === 'number', '有 added 计数');
  });
  await check('GET tools 列表', async () => {
    const r = await api.get('/api/tools');
    assertStatus(r, 200, 'tools');
    assert(Array.isArray(r.body), '返回数组');
  });
});

totalPass = r1.pass + r2.pass + r3.pass + r4.pass;
totalFail = r1.fail + r2.fail + r3.fail + r4.fail;
console.log(`\n═══ 冒烟测试 3 总计：${totalPass}/${totalPass + totalFail} passed ═══`);
if (totalFail > 0) process.exit(1);
