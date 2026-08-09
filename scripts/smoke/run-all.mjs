/**
 * 冒烟测试主入口：依次运行全部 6 个模块。
 * 用法：node scripts/smoke/run-all.mjs [repeat]
 * repeat=N 重复运行 N 次（测试稳定性）。
 */
const MODULES = [
  'smoke-1-core.mjs',
  'smoke-2-materials-artifacts.mjs',
  'smoke-3-executors-perms.mjs',
  'smoke-4-plugins.mjs',
  'smoke-5-b2b-temp.mjs',
  'smoke-6-delegation-handover.mjs',
];
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));

const repeat = parseInt(process.argv[2] ?? '1', 10);
let allPass = true;
for (let round = 1; round <= repeat; round++) {
  if (repeat > 1) console.log(`\n████ 第 ${round}/${repeat} 轮 ████`);
  for (const mod of MODULES) {
    const url = pathToFileURL(resolve(__dirname, mod)).href;
    const modExports = await import(`${url}?t=${Date.now()}-${round}`); // cache-busting
    // 每个模块自带的 exit(1) 会终止整个进程；改为捕获
  }
}
console.log('\n════════════════════════════════');
console.log(`全部 ${repeat} 轮冒烟测试完成`);
if (!allPass) process.exit(1);
