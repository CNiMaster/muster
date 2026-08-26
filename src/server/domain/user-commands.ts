/**
 * 用户斜杠命令域（capability parity 批次 D3，spec 2026-08-25-agent-host-parity-batches）。
 *
 * 存储：$MUSTER_HOME/commands/<token>.md（复用 user-skills 的文件式根结构）。
 * frontmatter：{ description, mode?, thinking?, model? }；正文=prompt 模板，
 * $ARGUMENTS 占位替换为用户参数。组织侧进化线：养蜂人可把常用工作流沉淀为命令
 * （与 Skill 管线同一条进化线，后续接 skill-synthesis 产出命令形态）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SERVER_CONFIG } from '../env';
import { AppError, ErrorCode } from '../../shared/errors';

/** 命令根（惰性求值：尊重测试/运行时 MUSTER_HOME 变更）。 */
export function commandsRoot(): string {
  return path.join(process.env.MUSTER_HOME ?? SERVER_CONFIG.musterDir, 'commands');
}

export interface UserCommand {
  token: string;
  description: string;
  /** 可选绑定：执行命令时随消息下发的选项。 */
  mode?: string;
  thinking?: string;
  model?: string;
  template: string;
}

const TOKEN_RE = /^[a-z][a-z0-9-]{0,30}$/;

/** 解析 frontmatter（yaml 子集：key: value 行，够用且零依赖）。 */
function parseCommandFile(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  let body = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = raw.slice(fm[0].length);
    for (const line of fm[1]!.split('\n')) {
      const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (m) meta[m[1]!] = m[2]!.trim();
    }
  }
  return { meta, body: body.trim() };
}

function readCommand(token: string): UserCommand {
  if (!TOKEN_RE.test(token)) throw new AppError(ErrorCode.VALIDATION, `命令名不合法：${token}（小写字母开头，可含数字/连字符）`);
  const file = path.join(commandsRoot(), `${token}.md`);
  if (!existsSync(file)) throw new AppError(ErrorCode.NOT_FOUND, `命令不存在：/${token}`);
  const { meta, body } = parseCommandFile(readFileSync(file, 'utf8'));
  return {
    token,
    description: meta.description ?? '',
    mode: meta.mode,
    thinking: meta.thinking,
    model: meta.model,
    template: body,
  };
}

export function listUserCommands(): UserCommand[] {
  if (!existsSync(commandsRoot())) return [];
  const out: UserCommand[] = [];
  for (const name of readdirSync(commandsRoot())) {
    if (!name.endsWith('.md')) continue;
    const token = name.slice(0, -3);
    if (!TOKEN_RE.test(token)) continue;
    try {
      out.push(readCommand(token));
    } catch { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => a.token.localeCompare(b.token));
}

export function getUserCommand(token: string): UserCommand {
  return readCommand(token);
}

export function saveUserCommand(input: { token: string; description?: string; mode?: string; thinking?: string; model?: string; template: string }): UserCommand {
  if (!TOKEN_RE.test(input.token)) throw new AppError(ErrorCode.VALIDATION, `命令名不合法：${input.token}`);
  if (!input.template.trim()) throw new AppError(ErrorCode.VALIDATION, '模板正文不能为空');
  mkdirSync(commandsRoot(), { recursive: true });
  const fm = [
    '---',
    `description: ${input.description ?? ''}`,
    ...(input.mode ? [`mode: ${input.mode}`] : []),
    ...(input.thinking ? [`thinking: ${input.thinking}`] : []),
    ...(input.model ? [`model: ${input.model}`] : []),
    '---',
    '',
  ].join('\n');
  writeFileSync(path.join(commandsRoot(), `${input.token}.md`), `${fm}${input.template.trim()}\n`, 'utf8');
  return readCommand(input.token);
}

export function deleteUserCommand(token: string): void {
  const file = path.join(commandsRoot(), `${token}.md`);
  if (!TOKEN_RE.test(token) || !existsSync(file)) throw new AppError(ErrorCode.NOT_FOUND, `命令不存在：/${token}`);
  rmSync(file);
}

/** 展开：$ARGUMENTS 替换为参数文本（无占位且有参数时追加在末尾）。 */
export function expandCommand(command: UserCommand, args: string): { content: string; options: { mode?: string; thinking?: string; model?: string } } {
  let content = command.template;
  if (content.includes('$ARGUMENTS')) content = content.split('$ARGUMENTS').join(args.trim());
  else if (args.trim()) content = `${content}\n\n${args.trim()}`;
  return {
    content,
    options: {
      ...(command.mode ? { mode: command.mode } : {}),
      ...(command.thinking ? { thinking: command.thinking } : {}),
      ...(command.model ? { model: command.model } : {}),
    },
  };
}
