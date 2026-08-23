#!/usr/bin/env node
/**
 * 四门统一判读（质量门收口）：直接读子进程退出码与 Tests passed 总数——
 * 任何 tail/grep 管道截尾都会吞失败明细（2026-08-23 I-a 假绿事故：`| tail -3` 让
 * main 带着挂掉的 11 例测试被判绿合入）。本脚本是唯一的门的判读口径。
 *
 * 用法：npm run gate [-- --fast]
 *   默认五步：preflight → tsc(-b --force 全量，防 tsbuildinfo 增量假绿) → vitest → smoke → e2e
 *   --fast 跳过 e2e（本地快速迭代用；合并前必跑全量）
 *
 * 环境口径：vitest 不带 MUSTER_KEEPAWAKE=off（会关掉 keepawake 单测自己）；smoke/e2e 必带。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAST = process.argv.includes('--fast');

function runStep(step) {
  const env = { ...process.env };
  if (step.keepawakeOff) env.MUSTER_KEEPAWAKE = 'off';
  else delete env.MUSTER_KEEPAWAKE;
  const t0 = Date.now();
  const r = spawnSync(step.cmd[0], step.cmd.slice(1), { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const logFile = join(tmpdir(), `gate-${step.name}.log`);
  try { writeFileSync(logFile, output); } catch { /* 日志落盘失败不影响判读 */ }

  let ok = r.status === 0;
  let detail = r.status === 0 ? 'exit 0' : `exit ${r.status}`;
  // vitest 附加判读：必须看到 "Tests  N passed" 且无 failed 字样（防进程被信号杀死却 exit 0 的极端态）
  if (step.name === 'vitest') {
    const m = output.match(/Tests\s+(\d+)\s+passed/);
    const failed = /Tests\s+\d+\s+failed/.test(output) || /Test Files\s+\d+\s+failed/.test(output);
    if (!m || failed) ok = false;
    detail = m ? `Tests ${m[1]} passed${failed ? ' + FAILED' : ''}` : '未找到 Tests passed 计数（输出异常）';
  }
  if (step.name === 'smoke') {
    const totals = [...output.matchAll(/总计：(\d+)\/(\d+) passed/g)].map((x) => `${x[1]}/${x[2]}`);
    detail = totals.length ? `smoke ${totals.join(' ')}` : detail;
  }
  const tail = output.trimEnd().split('\n').slice(-8).join('\n');
  return { name: step.name, ok, detail, secs, tail, logFile };
}

const steps = [
  { name: 'preflight', cmd: ['npm', 'run', 'preflight'], keepawakeOff: true },
  { name: 'tsc', cmd: ['npx', 'tsc', '-b', '--force'] },
  { name: 'vitest', cmd: ['npx', 'vitest', 'run'] },
  { name: 'smoke', cmd: ['npm', 'run', 'smoke'], keepawakeOff: true },
  ...(FAST ? [] : [{ name: 'e2e', cmd: ['npx', 'playwright', 'test'], keepawakeOff: true }]),
];

const results = [];
for (const step of steps) {
  console.log(`\n▶ ${step.name}: ${step.cmd.join(' ')}${step.keepawakeOff ? '（MUSTER_KEEPAWAKE=off）' : ''}`);
  const r = runStep(step);
  results.push(r);
  console.log(r.ok ? `✓ ${r.name} 通过（${r.secs}s，${r.detail}）` : `✗ ${r.name} 失败（${r.secs}s，${r.detail}）`);
  if (!r.ok) console.log(r.tail);
  console.log(`  完整日志：${r.logFile}`);
}

console.log('\n══════════ 四门结果 ══════════');
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(10)} ${r.detail}（${r.secs}s）`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? '\n全部通过。' : `\n${failed.length} 项失败：${failed.map((r) => r.name).join('、')}`);
process.exit(failed.length === 0 ? 0 : 1);
