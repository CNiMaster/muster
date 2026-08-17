/**
 * 冒烟测试主入口：依次运行全部 6 个模块。
 * 用法：node scripts/smoke/run-all.mjs [repeat]
 * repeat=N 重复运行 N 次（测试稳定性）。
 *
 * 公司退役批次C：不再要求外部 dev server——无 MUSTER_API 时自起隔离服务器
 * （MUSTER_HOME 指向临时目录 + 随机端口），跑完 kill + 清目录，杜绝真实库污染。
 * 已有 MUSTER_API 时（如 CI 预置服务器）原样复用。
 */
const MODULES = [
  'smoke-1-core.mjs',
  'smoke-2-materials-artifacts.mjs',
  'smoke-3-executors-perms.mjs',
  'smoke-4-plugins.mjs',
  'smoke-5-b2b-temp.mjs',
  'smoke-6-delegation-handover.mjs',
];
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));

async function waitHealth(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/health`;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* 未就绪，继续等 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let spawned = null;
let tmpHome = null;
if (!process.env.MUSTER_API) {
  tmpHome = fs.mkdtempSync(join(os.tmpdir(), 'muster-smoke-'));
  const port = 20000 + Math.floor(Math.random() * 15000);
  process.env.MUSTER_HOME = tmpHome;
  process.env.MUSTER_PORT = String(port);
  spawned = spawn(process.execPath, ['--import', 'tsx', resolve(__dirname, '../../src/server/server.ts')], {
    stdio: 'inherit',
    env: process.env,
  });
  process.env.MUSTER_API = `http://127.0.0.1:${port}`;
  if (!(await waitHealth(port))) {
    console.error('冒烟服务器启动超时');
    spawned.kill();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`隔离冒烟服务器 ${process.env.MUSTER_API}（MUSTER_HOME=${tmpHome}）`);
}

const repeat = parseInt(process.argv[2] ?? '1', 10);
let allPass = true;
try {
  for (let round = 1; round <= repeat; round++) {
    if (repeat > 1) console.log(`\n████ 第 ${round}/${repeat} 轮 ████`);
    for (const mod of MODULES) {
      const url = pathToFileURL(resolve(__dirname, mod)).href;
      await import(`${url}?t=${Date.now()}-${round}`); // cache-busting
    }
  }
} finally {
  if (spawned) {
    spawned.kill();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}
console.log('\n════════════════════════════════');
console.log(`全部 ${repeat} 轮冒烟测试完成`);
if (!allPass) process.exit(1);
