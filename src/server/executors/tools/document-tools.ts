/**
 * 文档生产 builtin（capability parity 批次 E，spec 2026-08-25-agent-host-parity-batches）。
 *
 * 定位：API 型执行器直接产出交付级文档（docx/xlsx/pdf/md），产物走 artifact 审批流。
 * 依赖：docx/exceljs/pdf-lib（开源选型，登记 THIRD_PARTY_NOTICES）。
 *
 * 工具：document_create（format+path+content|rows；overwrite 覆盖已存在文件——仍受
 * executeTool 的 write-file 守卫与先读后写校验约束）+ document_append（文本格式追加段落；
 * 二进制格式不支持追加，提示重生成）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolCall, ToolDefinition, ToolResult } from './file-tools';
import { isWithinWorkspace } from '../../sandbox';
import type { ToolContext } from './registry';

export const DOCUMENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'document_create',
      description:
        '生成交付级文档（Word/Excel/PDF/Markdown）。content=文本内容（docx/pdf/md 的段落或正文；\\n 分段）；rows=表格数据（xlsx 必填，二维数组，首行为表头）。已存在文件默认拒绝——先 read_file 后传 overwrite=true 覆盖。',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['docx', 'xlsx', 'pdf', 'md'], description: '目标格式' },
          path: { type: 'string', description: '输出文件相对路径（如 docs/报告.docx）' },
          title: { type: 'string', description: '文档标题（docx/pdf 首行）' },
          content: { type: 'string', description: '正文文本（\\n 分段；xlsx 不用）' },
          rows: { type: 'array', items: { type: 'array', items: {} }, description: '表格二维数组（xlsx 用，首行表头）' },
          overwrite: { type: 'boolean', description: '已存在时覆盖（需先读过该文件）' },
        },
        required: ['format', 'path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'document_append',
      description: '向已有 Markdown 文档追加段落（文本格式专用；docx/xlsx/pdf 不支持追加，请用 document_create 重新生成）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件相对路径' },
          content: { type: 'string', description: '追加的文本' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
];

/** 已存在性预检（不抛越界——真正写前 resolveTarget 会拦）。 */
function resolveTargetNoThrow(ctx: ToolContext, rel: string): string {
  try { return resolveTarget(ctx, rel); } catch { return path.resolve(ctx.workingDir, rel); }
}

function resolveTarget(ctx: ToolContext, rel: string): string {
  const target = path.resolve(ctx.workingDir, rel);
  // review 修复（P0）：与 write_file 同款越界校验——`../` 逃逸 worktree 拒绝
  if (!isWithinWorkspace(ctx.workingDir, target)) {
    throw new Error(`路径越界：${rel} 不在工作目录 ${ctx.workingDir} 内`);
  }
  return target;
}

/** 生成文档核心（可单测）。 */
export async function generateDocument(input: {
  format: 'docx' | 'xlsx' | 'pdf' | 'md';
  target: string;
  title?: string;
  content?: string;
  rows?: unknown[][];
}): Promise<{ bytes: Buffer; note: string }> {
  const text = input.content ?? '';
  if (input.format === 'md') {
    const body = input.title ? `# ${input.title}\n\n${text}` : text;
    return { bytes: Buffer.from(body, 'utf8'), note: 'markdown' };
  }
  if (input.format === 'docx') {
    const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import('docx');
    const paras = [
      ...(input.title ? [new Paragraph({ text: input.title, heading: HeadingLevel.HEADING_1 })] : []),
      ...text.split('\n').filter((p) => p.trim()).map((p) => new Paragraph({ children: [new TextRun(p)] })),
    ];
    const doc = new Document({ sections: [{ children: paras }] });
    const buf = await Packer.toBuffer(doc);
    return { bytes: Buffer.from(buf), note: 'docx' };
  }
  if (input.format === 'xlsx') {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(input.title?.slice(0, 31) || 'Sheet1');
    const rows = input.rows ?? [];
    for (const row of rows) ws.addRow(row);
    if (rows.length > 0) ws.getRow(1).font = { bold: true };
    const buf = await wb.xlsx.writeBuffer();
    return { bytes: Buffer.from(buf), note: `xlsx (${rows.length} 行)` };
  }
  // pdf
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const full = input.title ? `${input.title}\n\n${text}` : text;
  // 分页：每页 48 行、每行 90 字符（Helvetica 等宽近似；中文在 pdf-lib 标准字体缺字形——
  // content 含 CJK 时降级提示改用 docx/md，避免产出乱码 PDF）
  if (/[\u4e00-\u9fff]/.test(full)) {
    throw new Error('PDF 标准字体不含中文字形——中文文档请生成 docx 或 md（或让用户安装自定义字体支持）');
  }
  const lines = full.split('\n');
  for (let pageStart = 0; pageStart < Math.max(lines.length, 1); pageStart += 48) {
    const page = pdf.addPage([595.28, 841.89]);
    const slice = lines.slice(pageStart, pageStart + 48);
    slice.forEach((line, i) => {
      page.drawText(line.slice(0, 90), { x: 50, y: 800 - i * 16, size: 11, font });
    });
  }
  const bytes = await pdf.save();
  return { bytes: Buffer.from(bytes), note: 'pdf' };
}

export async function documentCreateHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const format = String(call.args.format ?? '') as 'docx' | 'xlsx' | 'pdf' | 'md';
  const rel = String(call.args.path ?? '');
  if (!rel.trim()) return { toolCallId: call.id, name: call.name, content: '错误：path 必填' };
  if (!['docx', 'xlsx', 'pdf', 'md'].includes(format)) {
    return { toolCallId: call.id, name: call.name, content: `错误：不支持的格式 ${format}（docx|xlsx|pdf|md）` };
  }
  if (format === 'xlsx' && !Array.isArray(call.args.rows)) {
    return { toolCallId: call.id, name: call.name, content: '错误：xlsx 需要 rows 二维数组（首行表头）' };
  }
  if (fs.existsSync(resolveTargetNoThrow(ctx, rel)) && call.args.overwrite !== true) {
    return { toolCallId: call.id, name: call.name, content: `文件已存在：${rel}。已读过且确认覆盖请传 overwrite=true。` };
  }
  try {
    const target = resolveTarget(ctx, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const { bytes, note } = await generateDocument({
      format,
      target,
      title: call.args.title ? String(call.args.title) : undefined,
      content: call.args.content ? String(call.args.content) : undefined,
      rows: Array.isArray(call.args.rows) ? (call.args.rows as unknown[][]) : undefined,
    });
    fs.writeFileSync(target, bytes);
    return { toolCallId: call.id, name: call.name, content: `已生成 ${rel}（${note}，${bytes.length} 字节）。产物建议走 submit_review 审批。` };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `生成失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function documentAppendHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const rel = String(call.args.path ?? '');
  const content = String(call.args.content ?? '');
  if (!rel.trim() || !content.trim()) return { toolCallId: call.id, name: call.name, content: '错误：path 和 content 必填' };
  if (!/\.(md|txt)$/i.test(rel)) {
    return { toolCallId: call.id, name: call.name, content: '仅支持 md/txt 追加；docx/xlsx/pdf 请用 document_create 重新生成。' };
  }
  let appendTarget: string | null = null;
  try {
    appendTarget = resolveTarget(ctx, rel);
    if (!fs.existsSync(appendTarget)) return { toolCallId: call.id, name: call.name, content: `文件不存在：${rel}（追加前先 document_create）` };
    fs.appendFileSync(appendTarget, `\n\n${content.trim()}`);
    return { toolCallId: call.id, name: call.name, content: `已追加到 ${rel}（${content.trim().length} 字）。` };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `追加失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
