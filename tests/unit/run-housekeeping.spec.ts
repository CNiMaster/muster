/**
 * 运行目录清扫单测：runs/<runId> 按 mtime TTL 清理，不触碰其他目录。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sweepStaleRunDirs } from '../../src/server/domain/run-housekeeping';

let home: string;
const prevHome = process.env.MUSTER_HOME;

beforeEach(() => {
  home = mkdtempSync('/tmp/muster-sweep-');
  process.env.MUSTER_HOME = home;
});

afterEach(() => {
  process.env.MUSTER_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('sweepStaleRunDirs', () => {
  it('删过期目录、保留新目录，且不动 runs 外与 runs 下的普通文件', () => {
    const oldRun = path.join(home, 'runs', 'run_old');
    const freshRun = path.join(home, 'runs', 'run_fresh');
    mkdirSync(oldRun, { recursive: true });
    mkdirSync(freshRun, { recursive: true });
    mkdirSync(path.join(oldRun, 'logs'), { recursive: true });
    writeFileSync(path.join(oldRun, 'logs', 'x.log'), 'old');
    writeFileSync(path.join(freshRun, 'tmp.txt'), 'fresh');
    // agents/ 是员工资产，清扫不得触碰
    const agentHome = path.join(home, 'agents', 'agent1');
    mkdirSync(agentHome, { recursive: true });
    writeFileSync(path.join(agentHome, 'keep.txt'), 'keep');

    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    utimesSync(path.join(oldRun, 'logs'), twentyDaysAgo, twentyDaysAgo);
    utimesSync(oldRun, twentyDaysAgo, twentyDaysAgo);

    const { removed } = sweepStaleRunDirs(14);
    expect(removed).toBe(1);
    expect(existsSync(oldRun)).toBe(false);
    expect(existsSync(freshRun)).toBe(true);
    expect(existsSync(agentHome)).toBe(true);
  });

  it('runs 目录不存在时静默返回零', () => {
    expect(sweepStaleRunDirs()).toEqual({ removed: 0 });
  });
});
