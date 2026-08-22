#!/usr/bin/env node
/**
 * H8 环境预检：测试/冒烟开跑前一次性发现系统安全拦截（macOS Gatekeeper 隔离属性、spawn 权限），
 * 把"测试中途随机炸出安全弹窗"变成"开跑前一次性处理"。
 *
 * 用法：npm run preflight（playwright webServer 已前置调用）
 * 跳过：MUSTER_SKIP_PREFLIGHT=1
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const isDarwin = platform() === 'darwin';
const root = path.resolve(new URL('.', import.meta.url).pathname, '..');

if (process.env.MUSTER_SKIP_PREFLIGHT === '1') {
  console.log('[preflight] MUSTER_SKIP_PREFLIGHT=1，跳过预检');
  process.exit(0);
}

/** 探测一个可执行文件能否正常 spawn（返回 null=正常，否则错误信息）。 */
function trySpawn(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000 }, (err) => {
      if (!err) return resolve(null);
      // 非零退出码不算 spawn 失败（--version 成功路径不会走到这）
      if (err.code === 'ENOENT') return resolve(`找不到 ${bin}（${err.message.split('\n')[0]}）`);
      return resolve(`${bin}: ${err.message.split('\n')[0]}`);
    });
  });
}

/** darwin：检测目标二进制的 com.apple.quarantine 隔离属性（Gatekeeper 拦截源）。 */
function quarantineCheck(target) {
  return new Promise((resolve) => {
    if (!isDarwin || !target) return resolve(null);
    execFile('xattr', ['-l', target], { timeout: 5_000 }, (err, stdout) => {
      if (err) return resolve(null); // xattr 不可用/文件不存在：交给 spawn 探测兜底
      resolve(stdout.includes('com.apple.quarantine') ? target : null);
    });
  });
}

const esbuildBin = path.join(root, 'node_modules', '.bin', 'esbuild');
let esbuildReal = null;
if (existsSync(esbuildBin)) {
  try { esbuildReal = realpathSync(esbuildBin); } catch { /* 符号链接断了交给 spawn 探测 */ }
}

const checks = [
  ['node', ['--version']],
  ['git', ['--version']],
  existsSync(esbuildBin) ? [esbuildBin, ['--version']] : null,
].filter(Boolean);

const failures = [];
for (const [bin, args] of checks) {
  const err = await trySpawn(bin, args);
  if (err) failures.push(err);
}

const quarantined = await quarantineCheck(esbuildReal);

if (failures.length === 0 && !quarantined) {
  console.log('[preflight] 通过：node/git/esbuild spawn 正常' + (isDarwin ? '，无隔离属性' : ''));
  process.exit(0);
}

console.error('\n[preflight] ✗ 环境预检未通过——请先完成以下处理再跑测试：\n');
for (const f of failures) console.error(`  - spawn 失败：${f}`);
if (quarantined) {
  console.error(`  - 检测到 macOS 隔离属性（Gatekeeper 会拦截并弹安全确认窗）：${quarantined}`);
  console.error('    处理方式二选一：');
  console.error('    a) 系统设置 → 隐私与安全性 → 底部「仍要打开」逐个允许；');
  console.error(`    b) 终端执行去隔离：xattr -dr com.apple.quarantine "${path.join(root, 'node_modules')}"`);
}
console.error('\n  处理完重跑 npm run preflight 确认通过。确认环境已处理但想强制开跑：MUSTER_SKIP_PREFLIGHT=1\n');
process.exit(1);
