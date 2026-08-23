/**
 * 升级演练（批次 L8）：隔离 home 里从零起服务=模拟「旧库跑新版」最短路径——
 * 验证迁移链可走通+待应用迁移触发 pre-migration 快照+健康端点可用。
 * 注：真·旧库演练=把真实备份三件套放进隔离 home 再跑（手动步骤，见 RELEASE-CHECKLIST）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'muster-drill-'));
const port = 21000 + Math.floor(Math.random() * 2000);
console.log(`演练 home=${home} port=${port}`);
const server = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/server/server.ts')], {
  env: { ...process.env, MUSTER_HOME: home, MUSTER_PORT: String(port), MUSTER_KEEPAWAKE: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
server.stdout.on('data', (d) => { out += d; });
server.stderr.on('data', (d) => { out += d; });
const ok = await (async () => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* boot 中 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
})();
server.kill();
let report = ok ? '服务健康启动 ✓' : `服务启动失败 ✗\n${out.slice(-2000)}`;
const snapRoot = join(home, 'backups', 'pre-migration');
const snaps = existsSync(snapRoot) ? readdirSync(snapRoot) : [];
report += snaps.length > 0 ? `\npre-migration 快照 ${snaps.length} 份 ✓` : '\n（全新库无待应用迁移=无快照，属正常；真旧库演练见 RELEASE-CHECKLIST）';
rmSync(home, { recursive: true, force: true });
console.log(report);
process.exit(ok ? 0 : 1);
