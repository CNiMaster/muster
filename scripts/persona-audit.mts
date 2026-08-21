/**
 * B4 人设审计脚本（只读——报告覆盖率，不改任何文件）。
 *
 * 用法：npx tsx scripts/persona-audit.mts [--root <personas目录>] [--min-body 1000] [--top 15]
 *
 * 输出：
 * - 总数 / tools 覆盖率 / 正文长度分布（min/median/mean/max）
 * - 薄壳清单（正文 < min-body 或无 tools，按需补 P0：tools + 可执行技术交付物）
 * - 按域分组统计（命中率口径的补齐排期参考）
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

interface PersonaStat {
  rel: string;
  name: string;
  domain: string;
  tools: number;
  bodyChars: number;
  thin: boolean;
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) walk(root, abs, out);
    else if (entry.endsWith('.md')) out.push(abs);
  }
}

function parse(file: string): { name: string; tools: number; bodyChars: number } | null {
  const content = readFileSync(file, 'utf8');
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?/);
  let name = '';
  let tools = 0;
  if (fm) {
    for (const line of fm[1]!.split('\n')) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key === 'name') name = value;
      if (key === 'tools') tools = value.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean).length;
    }
  }
  if (!name) return null;
  const body = fm ? content.slice(fm[0].length) : content;
  return { name, tools, bodyChars: body.length };
}

const args = process.argv.slice(2);
const rootArgIdx = args.indexOf('--root');
const minBodyIdx = args.indexOf('--min-body');
const topIdx = args.indexOf('--top');
const root = path.resolve(rootArgIdx >= 0 ? args[rootArgIdx + 1]! : 'personas');
const minBody = minBodyIdx >= 0 ? Number(args[minBodyIdx + 1]) : 1000;
const top = topIdx >= 0 ? Number(args[topIdx + 1]) : 15;

if (!existsSync(root)) {
  console.error(`personas 目录不存在：${root}`);
  process.exit(1);
}

const files: string[] = [];
walk(root, root, files);

const stats: PersonaStat[] = [];
for (const file of files) {
  const parsed = parse(file);
  if (!parsed) continue;
  const rel = path.relative(root, file).replace(/\.md$/, '');
  const domain = rel.includes('/') ? rel.split('/')[0]! : '(root)';
  const thin = parsed.bodyChars < minBody || parsed.tools === 0;
  stats.push({ rel, name: parsed.name, domain, tools: parsed.tools, bodyChars: parsed.bodyChars, thin });
}

const withTools = stats.filter((s) => s.tools > 0).length;
const lengths = stats.map((s) => s.bodyChars).sort((a, b) => a - b);
const median = lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)] : 0;
const mean = lengths.length > 0 ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;

console.log('=== 人设审计报告（只读）===');
console.log(`目录：${root}`);
console.log(`总数：${stats.length}`);
console.log(`tools 覆盖率：${withTools}/${stats.length}（${((withTools / Math.max(1, stats.length)) * 100).toFixed(1)}%）`);
console.log(`正文长度：min ${lengths[0] ?? 0} / median ${median} / mean ${mean} / max ${lengths.at(-1) ?? 0}`);

const byDomain = new Map<string, { total: number; withTools: number; thin: number }>();
for (const s of stats) {
  const d = byDomain.get(s.domain) ?? { total: 0, withTools: 0, thin: 0 };
  d.total += 1;
  if (s.tools > 0) d.withTools += 1;
  if (s.thin) d.thin += 1;
  byDomain.set(s.domain, d);
}
console.log('\n=== 按域统计 ===');
for (const [domain, d] of [...byDomain.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`${domain.padEnd(14)} 总 ${String(d.total).padStart(3)} ｜ 有tools ${String(d.withTools).padStart(3)} ｜ 薄壳 ${String(d.thin).padStart(3)}`);
}

const thinList = stats.filter((s) => s.thin).sort((a, b) => a.bodyChars - b.bodyChars).slice(0, top);
console.log(`\n=== 薄壳 Top ${thinList.length}（正文 < ${minBody} 或无 tools；补齐优先级按命中率另排）===`);
for (const s of thinList) {
  console.log(`${s.rel.padEnd(52)} ${String(s.bodyChars).padStart(6)} 字  tools=${s.tools}`);
}

const noTools = stats.filter((s) => s.tools === 0).length;
if (noTools > 0) {
  console.log(`\n提示：${noTools} 个人设无 tools 声明——新沉淀管线已强制带工具（B4 门禁），存量按命中率补齐。`);
}
