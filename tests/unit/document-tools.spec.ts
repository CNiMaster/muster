/**
 * capability parity 批次 E：文档生产——md/docx/xlsx/pdf 生成（魔数校验）、追加、护栏。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateDocument, documentCreateHandler, documentAppendHandler } from '../../src/server/executors/tools/document-tools';
import type { ToolContext } from '../../src/server/executors/tools/registry';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'muster-doc-'));
}

const mkCtx = (workingDir: string): ToolContext =>
  ({ workingDir, toolRegistry: null as unknown as ToolContext['toolRegistry'] } as ToolContext);

describe('generateDocument（核心）', () => {
  it('md：标题+正文', async () => {
    const { bytes } = await generateDocument({ format: 'md', target: 'x.md', title: '报告', content: '第一段\n第二段' });
    expect(bytes.toString('utf8')).toContain('# 报告');
    expect(bytes.toString('utf8')).toContain('第二段');
  });

  it('docx：zip 魔数 PK；xlsx：zip 魔数+多行', async () => {
    const docx = await generateDocument({ format: 'docx', target: 'x.docx', title: '标题', content: '中文段落一\n中文段落二' });
    expect(docx.bytes.subarray(0, 2).toString()).toBe('PK');
    const xlsx = await generateDocument({ format: 'xlsx', target: 'x.xlsx', rows: [['名称', '数量'], ['苹果', 3], ['香蕉', 5]] });
    expect(xlsx.bytes.subarray(0, 2).toString()).toBe('PK');
    expect(xlsx.note).toContain('3 行');
  });

  it('pdf：%PDF 魔数（英文）；中文内容拒绝（标准字体缺字形防乱码）', async () => {
    const pdf = await generateDocument({ format: 'pdf', target: 'x.pdf', title: 'Report', content: 'line one\nline two' });
    expect(pdf.bytes.subarray(0, 4).toString()).toBe('%PDF');
    await expect(generateDocument({ format: 'pdf', target: 'x.pdf', content: '中文' })).rejects.toThrow(/中文/);
  });
});

describe('handler 层', () => {
  it('document_create：md 落盘；已存在不 overwrite 拒绝；overwrite 覆盖', async () => {
    const dir = tmpDir();
    const ctx = mkCtx(dir);
    const r1 = await documentCreateHandler({ id: 't1', name: 'document_create', args: { format: 'md', path: 'docs/note.md', title: '纪要', content: '内容A' } }, ctx);
    expect(r1.content).toContain('已生成');
    expect(fs.readFileSync(path.join(dir, 'docs/note.md'), 'utf8')).toContain('内容A');
    const r2 = await documentCreateHandler({ id: 't2', name: 'document_create', args: { format: 'md', path: 'docs/note.md', content: '内容B' } }, ctx);
    expect(r2.content).toContain('已存在');
    const r3 = await documentCreateHandler({ id: 't3', name: 'document_create', args: { format: 'md', path: 'docs/note.md', content: '内容C', overwrite: true } }, ctx);
    expect(r3.content).toContain('已生成');
    expect(fs.readFileSync(path.join(dir, 'docs/note.md'), 'utf8')).toContain('内容C');
  });

  it('document_create：xlsx 无 rows 拒绝；未知格式拒绝', async () => {
    const ctx = mkCtx(tmpDir());
    const r1 = await documentCreateHandler({ id: 't4', name: 'document_create', args: { format: 'xlsx', path: 'a.xlsx' } }, ctx);
    expect(r1.content).toContain('rows');
    const r2 = await documentCreateHandler({ id: 't5', name: 'document_create', args: { format: 'pptx', path: 'a.pptx' } }, ctx);
    expect(r2.content).toContain('不支持的格式');
  });

  it('document_append：md 追加；二进制格式提示重生成；文件不存在提示', async () => {
    const dir = tmpDir();
    const ctx = mkCtx(dir);
    await documentCreateHandler({ id: 't6', name: 'document_create', args: { format: 'md', path: 'log.md', content: '首段' } }, ctx);
    const r1 = await documentAppendHandler({ id: 't7', name: 'document_append', args: { path: 'log.md', content: '追加段' } }, ctx);
    expect(r1.content).toContain('已追加');
    expect(fs.readFileSync(path.join(dir, 'log.md'), 'utf8')).toContain('追加段');
    const r2 = await documentAppendHandler({ id: 't8', name: 'document_append', args: { path: 'a.docx', content: 'x' } }, ctx);
    expect(r2.content).toContain('document_create');
    const r3 = await documentAppendHandler({ id: 't9', name: 'document_append', args: { path: 'none.md', content: 'x' } }, ctx);
    expect(r3.content).toContain('不存在');
  });
});

describe('review 修复：路径越界守卫', () => {
  it('document_create/append 的 ../ 逃逸 worktree 被拒', async () => {
    const dir = tmpDir();
    const ctx = mkCtx(dir);
    const r1 = await documentCreateHandler({ id: 's1', name: 'document_create', args: { format: 'md', path: '../../escape.md', content: 'x' } }, ctx);
    expect(r1.content).toContain('路径越界');
    const r2 = await documentAppendHandler({ id: 's2', name: 'document_append', args: { path: '../out.md', content: 'x' } }, ctx);
    expect(r2.content).toContain('路径越界');
    expect(require('node:fs').existsSync(require('node:path').join(dir, '../../escape.md'))).toBe(false);
  });
});
