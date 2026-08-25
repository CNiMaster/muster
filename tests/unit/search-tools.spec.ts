/**
 * capability parity 批次 A1：search_files / glob_files builtin 单测。
 * 临时目录夹具验证：命中格式/忽略目录/二进制跳过/glob 过滤/大小写/正则/护栏/无命中文案。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { globFilesList, searchFilesContent, searchFilesHandler, globFilesHandler } from '../../src/server/executors/tools/search-tools';

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-search-'));
  fs.mkdirSync(path.join(root, 'src', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'server', 'app.ts'), ['const APP_NAME = "muster";', '// TODO: refactor', 'export function start() { return APP_NAME; }'].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), ['export const helper = 1;', '// fixme: rename'].join('\n'));
  fs.writeFileSync(path.join(root, 'README.md'), '# Muster\nsearch_files test doc\n');
  fs.writeFileSync(path.join(root, 'data.json'), '{"searchable": false}');
  // 应被忽略的目录
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'searchable needle in node_modules');
  // 二进制（含 NUL）
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x61, 0x00, 0x62, 0x73, 0x65, 0x61, 0x72, 0x63, 0x68]));
  return root;
}

describe('searchFilesContent（内容检索核心）', () => {
  it('跨文件命中：文件:行号:行文本 格式 + 统计尾注', () => {
    const root = makeFixture();
    const r = searchFilesContent(root, '.', 'muster');
    expect(r.content).toContain('src/server/app.ts:1:const APP_NAME = "muster";');
    expect(r.content).toContain('README.md:1:# Muster');
    expect(r.content).toMatch(/个文件命中 \d+ 行/);
    expect(r.matchCount).toBeGreaterThanOrEqual(2);
  });

  it('忽略 node_modules/dist/.git', () => {
    const root = makeFixture();
    const r = searchFilesContent(root, '.', 'needle');
    expect(r.content).toContain('未找到匹配');
  });

  it('跳过二进制文件（NUL 探测）', () => {
    const root = makeFixture();
    // blob.bin 含 "search" 字节序列但因 NUL 前缀被跳过——用整词确认未命中二进制
    const r = searchFilesContent(root, '.', 'a\\x00bsearch|searchable');
    expect(r.content).not.toContain('blob.bin');
  });

  it('glob 只按文件名过滤', () => {
    const root = makeFixture();
    const r = searchFilesContent(root, '.', 'search', { glob: '*.md' });
    expect(r.content).toContain('README.md:');
    expect(r.content).not.toContain('data.json');
  });

  it('默认忽略大小写；ignoreCase:false 区分', () => {
    const root = makeFixture();
    expect(searchFilesContent(root, '.', 'app_name').matchCount).toBeGreaterThanOrEqual(1);
    expect(searchFilesContent(root, '.', 'app_name', { ignoreCase: false }).matchCount).toBe(0);
  });

  it('正则模式（TODO|FIXME）', () => {
    const root = makeFixture();
    const r = searchFilesContent(root, '.', 'TODO|FIXME');
    expect(r.content).toContain('app.ts:2:// TODO: refactor');
    expect(r.content).toContain('util.ts:2:// fixme: rename');
  });

  it('无效正则返回错误提示而非抛出', () => {
    const root = makeFixture();
    const r = searchFilesContent(root, '.', '([unclosed');
    expect(r.content).toContain('无效正则');
    expect(r.matchCount).toBe(0);
  });

  it('大文件跳过（>512KB）', () => {
    const root = makeFixture();
    fs.writeFileSync(path.join(root, 'big.log'), `${'x'.repeat(600 * 1024)}\nneedle-in-big\n`);
    const r = searchFilesContent(root, '.', 'needle-in-big');
    expect(r.content).toContain('未找到匹配');
  });

  it('maxResults 截断提示', () => {
    const root = makeFixture();
    fs.mkdirSync(path.join(root, 'many'), { recursive: true });
    for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(root, 'many', `f${i}.txt`), 'truncation-needle\n');
    const r = searchFilesContent(root, '.', 'truncation-needle', { maxResults: 10 });
    expect(r.content).toContain('已达返回上限 10 行');
  });
});

describe('globFilesList（按名找文件核心）', () => {
  it('全路径 glob 匹配（** 跨目录）', () => {
    const root = makeFixture();
    const r = globFilesList(root, '.', 'src/**/*.ts');
    expect(r.count).toBe(2);
    expect(r.content).toContain('src/server/app.ts');
    expect(r.content).toContain('src/util.ts');
    expect(r.content).not.toContain('README.md');
  });

  it('段内通配不跨目录', () => {
    const root = makeFixture();
    const r = globFilesList(root, '.', '*.md');
    expect(r.count).toBe(1);
    expect(r.content).toContain('README.md');
  });

  it('无命中文案', () => {
    const root = makeFixture();
    expect(globFilesList(root, '.', '**/*.xyz').content).toContain('未找到匹配文件');
  });
});

describe('handler 层（ToolCall 形状）', () => {
  const ctx = { workingDir: '' };

  it('searchFilesHandler：空 pattern 报错；正常调用返回内容', async () => {
    const root = makeFixture();
    ctx.workingDir = root;
    const bad = await searchFilesHandler({ id: 't1', name: 'search_files', args: { pattern: '' } }, ctx);
    expect(bad.content).toContain('pattern 不能为空');
    const ok = await searchFilesHandler({ id: 't2', name: 'search_files', args: { pattern: 'muster' } }, ctx);
    expect(ok.name).toBe('search_files');
    expect(ok.toolCallId).toBe('t2');
    expect(ok.content).toContain('app.ts:1:');
  });

  it('globFilesHandler：path 子目录限定', async () => {
    const root = makeFixture();
    ctx.workingDir = root;
    const r = await globFilesHandler({ id: 't3', name: 'glob_files', args: { pattern: '*.ts', path: 'src/server' } }, ctx);
    expect(r.content).toContain('app.ts');
    expect(r.content).not.toContain('util.ts');
  });
});
