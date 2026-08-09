/**
 * B3a Plugin 写侧测试：
 * - installPlugin upsert
 * - removePlugin
 * - setCompanyPluginEnabled + listEnabledCompanyPlugins
 * - markPluginHealth
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import {
  installPlugin,
  removePlugin,
  setCompanyPluginEnabled,
  listEnabledCompanyPlugins,
  markPluginHealth,
  getPluginRow,
} from '../../src/server/domain/plugin-install';
import { AppError, ErrorCode } from '../../src/shared/errors';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  companyId = createCompany(db, { name: 'co' }).id;
});

afterEach(() => tdb.close());

function makeMcpPlugin(id: string) {
  return installPlugin(db, {
    id,
    name: '测试 MCP',
    kind: 'mcp-server',
    source: { kind: 'company', companyId },
    scope: { level: 'company', companyId },
    manifest: {
      kind: 'mcp-server',
      mcp: { transport: 'stdio', command: 'echo', args: ['hi'] },
    },
    credentialKeys: ['API_KEY'],
  });
}

describe('installPlugin', () => {
  it('插入新 plugin', () => {
    const p = makeMcpPlugin('plg_test1');
    expect(p.id).toBe('plg_test1');
    expect(p.kind).toBe('mcp-server');
    expect(p.source).toEqual({ kind: 'company', companyId });
    expect(p.manifest.kind).toBe('mcp-server');
  });

  it('upsert：同 id 覆盖', () => {
    makeMcpPlugin('plg_test2');
    installPlugin(db, {
      id: 'plg_test2',
      name: '改名',
      kind: 'mcp-server',
      source: { kind: 'company', companyId },
      scope: { level: 'company', companyId },
      manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'ls' } },
    });
    const p = getPluginRow(db, 'plg_test2');
    expect(p.name).toBe('改名');
  });

  it('自动生成 id（缺省）', () => {
    const p = installPlugin(db, {
      name: 'auto',
      kind: 'skill',
      source: { kind: 'builtin' },
      scope: { level: 'platform' },
      manifest: { kind: 'skill', skill: { body: 'x' } },
    });
    expect(p.id).toMatch(/^plg_/);
  });
});

describe('removePlugin', () => {
  it('删除存在的 plugin', () => {
    makeMcpPlugin('plg_del');
    removePlugin(db, 'plg_del');
    expect(() => getPluginRow(db, 'plg_del')).toThrow(AppError);
  });

  it('删除不存在的抛 NOT_FOUND', () => {
    expect(() => removePlugin(db, 'nonexistent')).toThrow(AppError);
    try {
      removePlugin(db, 'nonexistent');
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.NOT_FOUND);
    }
  });
});

describe('公司级启停', () => {
  it('enable 后在启用列表中', () => {
    makeMcpPlugin('plg_en');
    setCompanyPluginEnabled(db, companyId, 'plg_en', true);
    expect(listEnabledCompanyPlugins(db, companyId)).toContain('plg_en');
  });

  it('disable 后不在启用列表中', () => {
    makeMcpPlugin('plg_dis');
    setCompanyPluginEnabled(db, companyId, 'plg_dis', true);
    setCompanyPluginEnabled(db, companyId, 'plg_dis', false);
    expect(listEnabledCompanyPlugins(db, companyId)).not.toContain('plg_dis');
  });

  it('启停不存在的 plugin 抛 NOT_FOUND', () => {
    expect(() => setCompanyPluginEnabled(db, companyId, 'nonexistent', true)).toThrow(AppError);
  });

  it('不同公司的启停互不影响', () => {
    const company2 = createCompany(db, { name: 'co2' }).id;
    makeMcpPlugin('plg_multi');
    setCompanyPluginEnabled(db, companyId, 'plg_multi', true);
    expect(listEnabledCompanyPlugins(db, companyId)).toContain('plg_multi');
    expect(listEnabledCompanyPlugins(db, company2)).not.toContain('plg_multi');
  });
});

describe('markPluginHealth', () => {
  it('成功标记 available', () => {
    makeMcpPlugin('plg_ok');
    markPluginHealth(db, 'plg_ok', true);
    const p = getPluginRow(db, 'plg_ok');
    expect(p.status).toBe('available');
    expect(p.healthError).toBeUndefined();
  });

  it('失败标记 error + healthError', () => {
    makeMcpPlugin('plg_err');
    markPluginHealth(db, 'plg_err', false, '连接超时');
    const p = getPluginRow(db, 'plg_err');
    expect(p.status).toBe('error');
    expect(p.healthError).toBe('连接超时');
  });
});

// ── opt-out 治理测试（20260809100000 迁移后语义）──────────────────────────
import {
  setCompanyPluginDecision,
  listDisabledCompanyPlugins,
  getCompanyPluginDecisions,
  getEffectivePluginsForCompany,
} from '../../src/server/domain/plugin-install';

describe('opt-out 治理：平台插件默认全开', () => {
  it('平台插件默认对公司生效（无需显式启用）', () => {
    installPlugin(db, {
      id: 'plg_platform1',
      name: '平台 MCP',
      kind: 'mcp-server',
      source: { kind: 'builtin' },
      scope: { level: 'platform' },
      manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'echo' } },
    });
    // 不做任何启用操作，effective 仍应包含它
    const effective = getEffectivePluginsForCompany(db, companyId);
    expect(effective.find((p) => p.id === 'plg_platform1')).toBeTruthy();
  });

  it('显式禁用平台插件后从 effective 移除', () => {
    installPlugin(db, {
      id: 'plg_platform2',
      name: '平台 MCP',
      kind: 'mcp-server',
      source: { kind: 'builtin' },
      scope: { level: 'platform' },
      manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'echo' } },
    });
    setCompanyPluginDecision(db, companyId, 'plg_platform2', 'disabled');
    const effective = getEffectivePluginsForCompany(db, companyId);
    expect(effective.find((p) => p.id === 'plg_platform2')).toBeFalsy();
    // listDisabledCompanyPlugins 应返回禁用集合
    expect(listDisabledCompanyPlugins(db, companyId).has('plg_platform2')).toBe(true);
  });

  it('撤销禁用（decision=enabled）后恢复生效', () => {
    installPlugin(db, {
      id: 'plg_platform3',
      name: '平台 MCP',
      kind: 'mcp-server',
      source: { kind: 'builtin' },
      scope: { level: 'platform' },
      manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'echo' } },
    });
    setCompanyPluginDecision(db, companyId, 'plg_platform3', 'disabled');
    setCompanyPluginDecision(db, companyId, 'plg_platform3', 'enabled');
    const effective = getEffectivePluginsForCompany(db, companyId);
    expect(effective.find((p) => p.id === 'plg_platform3')).toBeTruthy();
  });

  it('A 公司禁用不影响 B 公司', () => {
    const company2 = createCompany(db, { name: 'coB' }).id;
    installPlugin(db, {
      id: 'plg_platform4',
      name: '平台 MCP',
      kind: 'mcp-server',
      source: { kind: 'builtin' },
      scope: { level: 'platform' },
      manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'echo' } },
    });
    setCompanyPluginDecision(db, companyId, 'plg_platform4', 'disabled');
    // A 公司被禁用
    expect(getEffectivePluginsForCompany(db, companyId).find((p) => p.id === 'plg_platform4')).toBeFalsy();
    // B 公司仍生效
    expect(getEffectivePluginsForCompany(db, company2).find((p) => p.id === 'plg_platform4')).toBeTruthy();
  });
});

describe('opt-out 治理：公司独占插件', () => {
  it('公司独占插件仅对目标公司生效', () => {
    const company2 = createCompany(db, { name: 'coB' }).id;
    installPlugin(db, {
      id: 'plg_exclusive1',
      name: '专属法律 Skill',
      kind: 'skill',
      source: { kind: 'company', companyId },
      scope: { level: 'company', companyId },
      manifest: { kind: 'skill', skill: { body: '专属能力' } },
    });
    // 目标公司能看到
    expect(getEffectivePluginsForCompany(db, companyId).find((p) => p.id === 'plg_exclusive1')).toBeTruthy();
    // 其他公司看不到
    expect(getEffectivePluginsForCompany(db, company2).find((p) => p.id === 'plg_exclusive1')).toBeFalsy();
  });

  it('getCompanyPluginDecisions 返回三态标注', () => {
    installPlugin(db, {
      id: 'plg_dec1',
      name: 'P1',
      kind: 'skill',
      source: { kind: 'builtin' },
      scope: { level: 'platform' },
      manifest: { kind: 'skill', skill: { body: 'x' } },
    });
    setCompanyPluginDecision(db, companyId, 'plg_dec1', 'disabled');
    const decisions = getCompanyPluginDecisions(db, companyId);
    expect(decisions.get('plg_dec1')).toBe('disabled');
    // 未决策的插件不在 map 中（UI 据此显示 'default'）
    expect(decisions.has('plg_undecided')).toBe(false);
  });
});
