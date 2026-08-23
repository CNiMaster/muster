/**
 * smoke-2 环境漂移根因回归（isPathAllowed 假逃逸）：未存在目标在符号链接根下
 * （macOS /var/folders→/private/var/folders）必须经「最近已存在祖先归一」后比较，
 * 不得退词法——否则对已 realpath 的白名单根永不匹配（读/写产物全 403）。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPathAllowed } from '../../src/server/paths';

describe('realpathSafe 祖先归一（smoke-2 漂移回归）', () => {
  it('未存在目标（含未建的深层目录）在允许根内 → 放行（词法回退会假逃逸）', () => {
    // os.tmpdir() 在 macOS 是 /var/folders/...（词法），白名单根已 realpath 成 /private/var/...
    const deepNew = join(tmpdir(), `muster-rt-${Date.now()}`, 'sub', 'new.md'); // 全链不存在
    expect(existsSync(deepNew)).toBe(false);
    expect(isPathAllowed(deepNew)).toBe(true); // 修复前：词法 /var/... ≠ /private/var/... 根 → false
  });

  it('真实目录下目标与已存在目标口径一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muster-rt2-'));
    expect(isPathAllowed(join(dir, 'exists.txt'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('允许根外路径仍拒（祖先归一只救根内词法偏差，不开新口子）', () => {
    expect(isPathAllowed('/etc/passwd')).toBe(false);
    expect(isPathAllowed('/definitely/not/allowed/new-file.txt')).toBe(false);
  });
});
