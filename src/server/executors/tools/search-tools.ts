/**
 * 原生代码搜索 builtin（capability parity 批次 A1，spec 2026-08-25-agent-host-parity-batches）。
 *
 * 现状：API 型执行器只有 list_files+read_file——跨文件找符号/配置/报错只能逐层盲翻，
 * review 大仓库 token 爆炸。本模块补 search_files（内容 grep）与 glob_files（按名找文件），
 * 对齐 Agent 宿主标配（Grep/Glob 分工）。CLI 型执行器自带原生检索，不消费这两个 builtin。
 *
 * 安全：permissionAction='read-file'（executeTool 内过 path 守卫，与 read_file 同一审批流，
 * 搜索起点 path 参数即守卫锚点）；忽略 node_modules/dist/.git/build/coverage；NUL 探测跳过
 * 二进制；行数/文件数双重截断防上下文淹没。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolCall, ToolDefinition, ToolResult } from './file-tools';

/** 忽略的目录名（按需追加；lock 文件按大小兜底跳过）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', 'test-results', 'playwright-report']);

/** 扫描护栏：超过即停止并提示缩小范围。 */
const MAX_FILES_SCANNED = 5_000;
/** 单文件护栏：超过视为数据文件跳过（lock/minified/数据集）。 */
const MAX_FILE_BYTES = 512 * 1024;
/** 输出护栏：匹配行与文件名列表的条数上限。 */
const MAX_RESULTS = 200;
/** 单行输出截断。 */
const MAX_LINE_CHARS = 200;

/** 简易 glob → RegExp：`**` 跨目录、`*` 段内通配、`?` 单字符；其余转义。 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // `**/` 匹配零或多层目录（src/**/*.ts 也要命中 src/util.ts）
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** 判定文本是否疑似二进制（前 4KB 内含 NUL）。 */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 4096).includes(0);
}

interface WalkState {
  scanned: number;
  truncated: boolean;
}

/** 递归收集目录下文件（相对根的路径列表）；遵守忽略表与扫描护栏。 */
function walkFiles(root: string, rel: string, out: string[], state: WalkState): void {
  if (state.truncated) return;
  const normRel = rel === '.' ? '' : rel;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(normRel ? path.join(root, normRel) : root, { withFileTypes: true });
  } catch {
    return; // 无权限/已删除——静默跳过
  }
  for (const e of entries) {
    if (state.truncated) return;
    const childRel = normRel ? `${normRel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkFiles(root, childRel, out, state);
    } else if (e.isFile()) {
      if (out.length >= MAX_FILES_SCANNED) {
        state.truncated = true;
        return;
      }
      out.push(childRel);
    }
  }
}

export const SEARCH_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        '在项目文件里做内容检索（grep 语义）：返回 `文件:行号:行文本` 匹配列表。用于跨文件定位符号、函数定义、配置项、报错信息——比逐个 read_file 高效得多。默认忽略 node_modules/dist/.git，跳过二进制与大文件。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式（如 \'assembleContext\'、\'TODO|FIXME\'）' },
          glob: { type: 'string', description: '可选文件名过滤（如 \'*.ts\'、\'*.json\'，只匹配文件名不含路径）' },
          path: { type: 'string', description: '搜索起点（相对工作目录），默认 \'.\'' },
          ignoreCase: { type: 'boolean', description: '忽略大小写，默认 true' },
          maxResults: { type: 'integer', description: '返回匹配行上限，默认 200', minimum: 10, maximum: 500 },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_files',
      description:
        '按 glob 模式列出文件路径（如 \'src/**/*.spec.ts\'、\'docs/*.md\'）。用于找文件在哪、确认某类文件的存在与分布。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: "glob 模式，'*' 段内通配、'**' 跨目录（如 '**/*.test.ts'）" },
          path: { type: 'string', description: '搜索起点（相对工作目录），默认 \'.\'' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
];

/** 内容检索核心：可单测（不依赖 ToolCall 形状）。 */
export function searchFilesContent(
  root: string,
  relDir: string,
  pattern: string,
  opts: { glob?: string; ignoreCase?: boolean; maxResults?: number } = {},
): { content: string; matchCount: number; scannedCount: number } {
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.ignoreCase === false ? '' : 'i');
  } catch (e) {
    return { content: `无效正则：${e instanceof Error ? e.message : String(e)}`, matchCount: 0, scannedCount: 0 };
  }
  const nameFilter = opts.glob ? globToRegExp(opts.glob) : null;
  const cap = Math.min(Math.max(opts.maxResults ?? MAX_RESULTS, 10), 500);
  const files: string[] = [];
  const state: WalkState = { scanned: 0, truncated: false };
  walkFiles(root, relDir, files, state);
  const lines: string[] = [];
  let matchCount = 0;
  let scannedCount = 0;
  let filesWithMatch = 0;
  for (const rel of files) {
    if (lines.length >= cap) break;
    const base = path.basename(rel);
    if (nameFilter && !nameFilter.test(base)) continue;
    const abs = path.join(root, rel);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    scannedCount += 1;
    if (looksBinary(buf)) continue;
    const text = buf.toString('utf8');
    const textLines = text.split('\n');
    let fileHadMatch = false;
    for (let i = 0; i < textLines.length && lines.length < cap; i += 1) {
      const line = textLines[i]!;
      if (!re.test(line)) continue;
      matchCount += 1;
      fileHadMatch = true;
      const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line.trimEnd();
      lines.push(`${rel}:${i + 1}:${shown}`);
    }
    if (fileHadMatch) filesWithMatch += 1;
  }
  const truncatedNote = lines.length >= cap ? `\n(已达返回上限 ${cap} 行，可缩小 glob/path 或更具体的 pattern)` : '';
  const scanNote = state.truncated ? `\n(扫描文件数达 ${MAX_FILES_SCANNED} 上限，建议指定更小的 path)` : '';
  const content =
    matchCount === 0
      ? `未找到匹配（pattern=${pattern}，扫描 ${scannedCount} 个文件${nameFilter ? `，glob=${opts.glob}` : ''}）。`
      : `${lines.join('\n')}\n\n(${filesWithMatch} 个文件命中 ${matchCount} 行；扫描 ${scannedCount} 个文件)${truncatedNote}${scanNote}`;
  return { content, matchCount, scannedCount };
}

export async function searchFilesHandler(call: ToolCall, ctx: { workingDir: string }): Promise<ToolResult> {
  const pattern = String(call.args.pattern ?? '');
  if (!pattern) return { toolCallId: call.id, name: call.name, content: '错误：pattern 不能为空' };
  const relDir = String(call.args.path ?? '.');
  const root = path.resolve(ctx.workingDir, relDir);
  try {
    const result = searchFilesContent(root, '.', pattern, {
      glob: call.args.glob ? String(call.args.glob) : undefined,
      ignoreCase: call.args.ignoreCase === undefined ? true : Boolean(call.args.ignoreCase),
      maxResults: call.args.maxResults === undefined ? undefined : Number(call.args.maxResults),
    });
    return { toolCallId: call.id, name: call.name, content: result.content };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `检索失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** glob 找文件核心：可单测。 */
export function globFilesList(root: string, relDir: string, pattern: string): { content: string; count: number } {
  const re = globToRegExp(pattern);
  const files: string[] = [];
  const state: WalkState = { scanned: 0, truncated: false };
  walkFiles(root, relDir, files, state);
  const matched: string[] = [];
  for (const rel of files) {
    if (matched.length >= MAX_RESULTS) break;
    if (re.test(rel)) matched.push(rel);
  }
  const truncatedNote = matched.length >= MAX_RESULTS ? `\n(已达返回上限 ${MAX_RESULTS} 条)` : '';
  const content =
    matched.length === 0
      ? `未找到匹配文件（pattern=${pattern}）。`
      : `${matched.join('\n')}\n\n(共 ${matched.length} 个文件)${truncatedNote}`;
  return { content, count: matched.length };
}

export async function globFilesHandler(call: ToolCall, ctx: { workingDir: string }): Promise<ToolResult> {
  const pattern = String(call.args.pattern ?? '');
  if (!pattern) return { toolCallId: call.id, name: call.name, content: '错误：pattern 不能为空' };
  const relDir = String(call.args.path ?? '.');
  const root = path.resolve(ctx.workingDir, relDir);
  try {
    const result = globFilesList(root, '.', pattern);
    return { toolCallId: call.id, name: call.name, content: result.content };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `检索失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
