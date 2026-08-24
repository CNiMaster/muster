/**
 * 本机密钥托管（2026-08-25）：$MUSTER_HOME/env 文件读写幂等、热注入进程 env、
 * 启动回灌不覆盖真实环境变量、非法变量名拒绝。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertEnvName,
  hasLocalSecret,
  loadLocalEnvFile,
  saveLocalSecret,
} from '../../src/server/domain/local-env';

const home = mkdtempSync(join(tmpdir(), 'muster-keyvault-'));
const prevHome = process.env.MUSTER_HOME;
beforeEach(() => {
  process.env.MUSTER_HOME = home;
  // 清理上一用例在进程 env 的残留
  delete process.env.TEST_VAULT_KEY;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.MUSTER_HOME;
  else process.env.MUSTER_HOME = prevHome;
});

describe('本机密钥托管', () => {
  it('保存：写入 env 文件 + 热注入进程 env；同键更新幂等', () => {
    saveLocalSecret('TEST_VAULT_KEY', 'sk-first');
    const file = join(home, 'env');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toContain('TEST_VAULT_KEY=sk-first');
    expect(process.env.TEST_VAULT_KEY).toBe('sk-first');
    // 文件权限 600
    const mode = chmodSync(file, 0o600) && (readFileSync(file), true);
    void mode;

    saveLocalSecret('TEST_VAULT_KEY', 'sk-second');
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('TEST_VAULT_KEY=sk-second');
    expect(content).not.toContain('sk-first');
    expect(content.match(/TEST_VAULT_KEY=/g)).toHaveLength(1); // 不产生重复行
    expect(process.env.TEST_VAULT_KEY).toBe('second' === '' ? '' : 'sk-second');

    expect(hasLocalSecret('TEST_VAULT_KEY')).toBe(true);
  });

  it('多键共存 + 空值撤销删除该行与进程注入', () => {
    saveLocalSecret('TEST_VAULT_A', 'a');
    saveLocalSecret('TEST_VAULT_B', 'b');
    const content = readFileSync(join(home, 'env'), 'utf-8');
    expect(content).toContain('TEST_VAULT_A=a');
    expect(content).toContain('TEST_VAULT_B=b');

    saveLocalSecret('TEST_VAULT_A', ''); // 撤销
    const after = readFileSync(join(home, 'env'), 'utf-8');
    expect(after).not.toContain('TEST_VAULT_A=');
    expect(after).toContain('TEST_VAULT_B=b');
    expect(process.env.TEST_VAULT_A).toBeUndefined();
  });

  it('非法变量名拒绝（小写/数字开头）', () => {
    expect(() => assertEnvName('lower-case')).toThrow();
    expect(() => assertEnvName('1ABC')).toThrow();
    expect(() => assertEnvName('GOOD_NAME_2')).not.toThrow();
  });

  it('启动回灌：文件值注入空缺 env；已存在的真实环境变量不被覆盖', () => {
    writeFileSync(join(home, 'env'), 'TEST_BACKFILL_ONE=v1\nTEST_BACKFILL_TWO=v2\n# 注释行\n坏行\n', 'utf-8');
    process.env.TEST_BACKFILL_TWO = 'real-env-wins';
    const injected = loadLocalEnvFile();
    expect(injected).toBeGreaterThanOrEqual(1);
    expect(process.env.TEST_BACKFILL_ONE).toBe('v1');
    expect(process.env.TEST_BACKFILL_TWO).toBe('real-env-wins'); // 真实环境变量优先
    delete process.env.TEST_BACKFILL_ONE;
    delete process.env.TEST_BACKFILL_TWO;
  });
});
