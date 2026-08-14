/**
 * 能力商城预置策展 M1 集成测试。
 *
 * 覆盖：preset 数据自洽 / 状态判定 / 三层去重（同源 409、异源装新停旧、无同名直装）/
 * 注入链（安装的 skill 真实进入 resolveTaskSkills）/ getEffectivePluginsForCompany 同名 winner 唯一。
 */
import { describe, expect, it } from 'vitest';
import { createCompany } from '../../src/server/domain/company';
import { createProject } from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';
import { createTask } from '../../src/server/domain/task';
import { resolveTaskSkills } from '../../src/server/domain/capability-binding';
import { installPlugin, getEffectivePluginsForCompany } from '../../src/server/domain/plugin-install';
import { recordCapabilityUsage } from '../../src/server/domain/capability-quality';
import {
  listMarketplacePresets,
  installPreset,
  findPreset,
} from '../../src/server/domain/marketplace-presets';
import {
  MARKETPLACE_PRESETS,
  validateMarketplacePresets,
} from '../../src/shared/marketplace-presets';
import { AppError } from '../../src/shared/errors';
import { makeTestDb } from './setup';

const fakeFetcher = async (): Promise<string> => '# 模拟 SKILL.md 正文\n这是一个测试技能。';

describe('marketplace presets 数据自洽', () => {
  it('预置目录 ≥10 条且无重复 id / (kind,name) / 非白名单策展方', () => {
    expect(MARKETPLACE_PRESETS.length).toBeGreaterThanOrEqual(10);
    expect(validateMarketplacePresets()).toEqual([]);
  });

  it('每条预置可被 findPreset 命中且 install 定位完整', () => {
    for (const p of MARKETPLACE_PRESETS) {
      expect(findPreset(p.id)?.id).toBe(p.id);
      if (p.install.type === 'raw-skill') expect(p.install.pin.length).toBeGreaterThan(20);
      if (p.install.type === 'mcp-command') expect(p.install.args.length).toBeGreaterThan(0);
    }
  });
});

describe('marketplace presets 状态与安装', () => {
  it('初始全部 installable', () => {
    const { db } = makeTestDb();
    const list = listMarketplacePresets(db);
    expect(list.every((p) => p.installState === 'installable')).toBe(true);
  });

  it('raw-skill 预置：装后变 installed 且 plugin 落库', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    const plugin = await installPreset(db, 'skill-docx', { level: 'company', companyId: company.id }, { fetcher: fakeFetcher });
    expect(plugin.kind).toBe('skill');
    expect(plugin.source.kind).toBe('marketplace');
    const list = listMarketplacePresets(db);
    expect(list.find((p) => p.id === 'skill-docx')?.installState).toBe('installed');
  });

  it('mcp-command 预置：装为 mcp-server 且 manifest 含 command/args', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    const plugin = await installPreset(db, 'mcp-filesystem', { level: 'company', companyId: company.id });
    expect(plugin.kind).toBe('mcp-server');
    expect(plugin.manifest.kind).toBe('mcp-server');
    if (plugin.manifest.kind === 'mcp-server') {
      expect(plugin.manifest.mcp.command).toBe('npx');
      expect(plugin.manifest.mcp.args?.[1]).toMatch(/@modelcontextprotocol\/server-filesystem@/);
    }
  });

  it('同源重复安装 → CONFLICT（已安装）', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    await installPreset(db, 'skill-docx', { level: 'company', companyId: company.id }, { fetcher: fakeFetcher });
    await expect(
      installPreset(db, 'skill-docx', { level: 'company', companyId: company.id }, { fetcher: fakeFetcher }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('异源同名：不替换 → CONFLICT；replaceExisting → 装新停旧', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    // 先装一个异源同名 skill（builtin source 占位）
    const old = installPlugin(db, {
      name: 'docx',
      kind: 'skill',
      source: { kind: 'builtin' },
      scope: { level: 'platform' },
      manifest: { kind: 'skill', skill: { body: '# 旧版 docx' } },
    });
    // 状态：conflict
    expect(listMarketplacePresets(db).find((p) => p.id === 'skill-docx')?.installState).toBe('conflict');
    // 不替换 → 报冲突
    await expect(
      installPreset(db, 'skill-docx', { level: 'company', companyId: company.id }, { fetcher: fakeFetcher }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // 替换 → 装新，旧条目在公司 scope 被禁用
    const fresh = await installPreset(
      db,
      'skill-docx',
      { level: 'company', companyId: company.id },
      { fetcher: fakeFetcher, replaceExisting: true },
    );
    expect(fresh.id).not.toBe(old.id);
    const effective = getEffectivePluginsForCompany(db, company.id);
    const docx = effective.find((p) => p.name === 'docx' && p.kind === 'skill');
    expect(docx?.id).toBe(fresh.id); // winner 是新装的，旧的已被禁用不生效
  });
});

describe('注入链：安装的 skill 真实进入任务上下文', () => {
  it('resolveTaskSkills 命中 requiredSkillIds 时读 plugin 表 skill 正文', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    const lead = createAgent(db, { companyId: company.id, name: '负责人', role: 'lead' });
    const project = createProject(db, { companyId: company.id, name: 'P', firstAgentId: lead.id });
    // 安装 docx skill（公司 scope）
    await installPreset(db, 'skill-docx', { level: 'company', companyId: company.id }, { fetcher: fakeFetcher });
    const task = createTask(db, {
      projectId: project.id,
      assigneeAgentId: lead.id,
      title: '写文档',
      requiredSkillIds: ['docx'],
    });
    const resolved = resolveTaskSkills(db, task);
    const docx = resolved.find((s) => s.skillId === 'docx');
    expect(docx?.status).toBe('loaded');
    expect(docx?.content).toContain('模拟 SKILL.md 正文');
  });
});

describe('M4 质量信号排序（推荐反映真实可用性）', () => {
  it('有质量信号的条目浮到前部；信号变化 → 排序变化', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    const fs = await installPreset(db, 'mcp-filesystem', { level: 'company', companyId: company.id });
    const gh = await installPreset(db, 'mcp-github', { level: 'company', companyId: company.id });

    // 无信号：保持策展目录顺序（filesystem 在 github 前）
    const order0 = listMarketplacePresets(db).map((p) => p.id);
    expect(order0.indexOf('mcp-filesystem')).toBeLessThan(order0.indexOf('mcp-github'));

    // filesystem 5 成功（1.0 × 0.8 + 0.5 × 0.2 = 0.9）；github 3 失败（0.06）
    for (let i = 0; i < 5; i++) recordCapabilityUsage(db, { capabilityId: fs.id, outcome: 'success' });
    for (let i = 0; i < 3; i++) recordCapabilityUsage(db, { capabilityId: gh.id, outcome: 'fail' });

    const scored0 = listMarketplacePresets(db).filter((p) => p.quality);
    expect(scored0[0].id).toBe('mcp-filesystem');
    // filesystem 浮到全列表最前（质量分最高）
    expect(listMarketplacePresets(db)[0].id).toBe('mcp-filesystem');

    // 信号变化：filesystem 追加 5 失败（0.5×0.8+0.2=0.6）；github 追加 5 成功（0.625×0.8+0.2=0.7）→ 反超
    for (let i = 0; i < 5; i++) recordCapabilityUsage(db, { capabilityId: fs.id, outcome: 'fail' });
    for (let i = 0; i < 5; i++) recordCapabilityUsage(db, { capabilityId: gh.id, outcome: 'success' });
    const scored1 = listMarketplacePresets(db).filter((p) => p.quality);
    expect(scored1[0].id).toBe('mcp-github');
  });
});

describe('review 修复：平台级装新停旧 + 注入优先级 + winner 身份（C1/H1）', () => {
  it('C1：平台 scope 装新停旧——旧条目 status=disabled 后，新条目成为 effective winner', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    // 旧同名平台条目（模拟用户此前装过 github MCP）
    const old = installPlugin(db, {
      name: 'github',
      kind: 'mcp-server',
      source: { kind: 'builtin' },
      scope: { level: 'platform' },
      manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'npx', args: ['old'] } },
    });
    // 平台级「装新停旧」
    const fresh = await installPreset(db, 'mcp-github', { level: 'platform' }, { replaceExisting: true });
    expect(fresh.id).not.toBe(old.id);
    const effective = getEffectivePluginsForCompany(db, company.id);
    const github = effective.find((p) => p.kind === 'mcp-server' && p.name === 'github');
    // 旧条目被 status=disabled 排除，新条目成为唯一 winner（C1 曾失败：旧行先入者胜出）
    expect(github?.id).toBe(fresh.id);
    // 平台级替换后旧行确实被置 disabled
    const oldRow = db.prepare('SELECT status FROM plugin WHERE id = ?').get(old.id) as { status: string };
    expect(oldRow.status).toBe('disabled');
  });

  it('H1：注入链 plugin 优先于仓库 bundled 目录——商城新正文盖过内置同名 skill', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    const lead = createAgent(db, { companyId: company.id, name: '负责人', role: 'lead' });
    const project = createProject(db, { companyId: company.id, name: 'P', firstAgentId: lead.id });
    // 装一个与仓库内置同名的 skill（incremental-implementation 在 skills/ 目录存在），正文标记商城版本
    installPlugin(db, {
      name: 'incremental-implementation',
      kind: 'skill',
      source: { kind: 'marketplace', registry: 'manual', ref: 'test' },
      scope: { level: 'company', companyId: company.id },
      manifest: { kind: 'skill', skill: { body: '# 商城新版正文' } },
    });
    const task = createTask(db, {
      projectId: project.id,
      assigneeAgentId: lead.id,
      title: '实现需求',
      requiredSkillIds: ['incremental-implementation'],
    });
    const resolved = resolveTaskSkills(db, task);
    const hit = resolved.find((s) => s.skillId === 'incremental-implementation');
    expect(hit?.status).toBe('loaded');
    // plugin 表正文必须盖过 bundled 目录（H1 曾失败：bundled 优先，商城正文永远进不了上下文）
    expect(hit?.content).toBe('# 商城新版正文');
  });

  it('winner 身份：实体行盖过只读视图同名条目（不只数量=1）', () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    installPlugin(db, {
      name: 'incremental-implementation',
      kind: 'skill',
      source: { kind: 'marketplace', registry: 'manual', ref: 'test' },
      scope: { level: 'platform' },
      manifest: { kind: 'skill', skill: { body: '# 实体行' } },
    });
    const effective = getEffectivePluginsForCompany(db, company.id);
    const hits = effective.filter((p) => p.kind === 'skill' && p.name === 'incremental-implementation');
    expect(hits.length).toBe(1);
    expect(hits[0].id.startsWith('plg_')).toBe(true); // 胜者是实体行而非 skill:xxx 视图
  });
});

describe('getEffectivePluginsForCompany 同名 winner 唯一（防御）', () => {
  it('实体行 > 只读视图：同名只返回实体行', () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    // 直接插两条同名实体行（绕过 installPreset 的去重，模拟历史脏数据）
    installPlugin(db, {
      name: 'github',
      kind: 'mcp-server',
      source: { kind: 'marketplace', registry: 'manual', ref: 'a' },
      scope: { level: 'platform' },
      manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'npx', args: ['a'] } },
    });
    installPlugin(db, {
      name: 'github',
      kind: 'mcp-server',
      source: { kind: 'marketplace', registry: 'manual', ref: 'b' },
      scope: { level: 'platform' },
      manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'npx', args: ['b'] } },
    });
    const effective = getEffectivePluginsForCompany(db, company.id);
    const github = effective.filter((p) => p.kind === 'mcp-server' && p.name === 'github');
    expect(github.length).toBe(1); // 唯一 winner，不双双进上下文
  });
});
