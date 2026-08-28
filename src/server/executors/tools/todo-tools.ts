/**
 * 原生 todo builtin（capability parity 批次 A3，spec 2026-08-25-agent-host-parity-batches）。
 *
 * 定位：执行循环内的轻量任务清单——模型的草稿纸，不是业务任务卡。长任务里模型用它自锚
 * （列清单→逐项推进→勾完成），对抗多轮循环中的目标漂移。与任务树解耦：业务侧任务
 * 归 task-engine，这里只服务单次执行的工作记忆。
 *
 * 存储：$MUSTER_HOME/todo/<taskId>.json（task 隔离；runToolLoop 的 usage/trace/progress
 * tracking 与 loopback 均携带 taskId，取首个可用来源）。无任务上下文（taskId 缺失）时
 * 返回提示而非报错。权限：无 permissionAction——写的是 MUSTER_HOME 自有草稿区，
 * 不经文件守卫；todo_write 时向执行现场（ctx.workingDir=任务 worktree）镜像一份人类可读的
 * .muster/task_plan.md（计划活文档 S1：压缩/清会话杀不死、随现场走；.gitignore 挡住不混入
 * checkpoint 提交），镜像失败绝不影响草稿纸主功能。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { realtime } from '../../realtime';
import type { ToolCall, ToolDefinition, ToolResult } from './file-tools';
import type { ToolContext } from './registry';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'done';
}

const MAX_TODO_ITEMS = 50;
const MAX_TODO_CONTENT_CHARS = 200;

function musterHome(): string {
  return process.env.MUSTER_HOME ?? `${process.env.HOME ?? '/tmp'}/.muster`;
}

/** 从 ToolContext 取任务锚（runToolLoop 注入；直调场景可能缺失）。 */
export function resolveTodoTaskId(ctx: ToolContext): string | null {
  return ctx.taskId ?? ctx.loopback?.taskId ?? null;
}

function todoPath(taskId: string): string {
  return path.join(musterHome(), 'todo', `${taskId}.json`);
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/** 读清单（可单测）：文件缺失/损坏返回空清单（草稿纸丢了不致命）。 */
export function readTodoList(taskId: string, home = musterHome()): TodoItem[] {
  const file = path.join(home, 'todo', `${taskId}.json`);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((it): it is TodoItem => {
        const item = it as TodoItem;
        return typeof item?.content === 'string' && (item.status === 'pending' || item.status === 'in_progress' || item.status === 'done');
      })
      .slice(0, MAX_TODO_ITEMS);
  } catch {
    return [];
  }
}

/** 写清单（可单测）：整体替换 + 条数/长度夹紧。 */
export function writeTodoList(taskId: string, items: TodoItem[], home = musterHome()): TodoItem[] {
  const clamped: TodoItem[] = items
    .filter((it) => typeof it?.content === 'string' && it.content.trim().length > 0)
    .map((it): TodoItem => ({
      content: it.content.trim().slice(0, MAX_TODO_CONTENT_CHARS),
      status: it.status === 'in_progress' || it.status === 'done' ? it.status : 'pending',
    }))
    .slice(0, MAX_TODO_ITEMS);
  const dir = path.join(home, 'todo');
  mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, `${taskId}.json`), `${JSON.stringify(clamped, null, 2)}\n`);
  return clamped;
}

/** 三态勾选渲染（todo_read 回显 + S2 目标回执/启动回读共用）。 */
export function renderTodo(items: TodoItem[]): string {
  if (items.length === 0) return '清单为空。用 todo_write 写入 [{content, status}] 建立工作清单。';
  const lines = items.map((it, i) => `${i + 1}. [${it.status === 'done' ? 'x' : it.status === 'in_progress' ? '>' : ' '}] ${it.content}`);
  const done = items.filter((it) => it.status === 'done').length;
  return `${lines.join('\n')}\n\n(完成 ${done}/${items.length})`;
}

/** 计划活文档 S1：todo 清单 → 人类可读的 task_plan.md 文本（进程三态：x=完成 >号=进行中 空格=待处理）。 */
export function renderTaskPlanMarkdown(taskId: string, items: TodoItem[], now = new Date()): string {
  const done = items.filter((it) => it.status === 'done').length;
  const lines = items.map((it) => `- [${it.status === 'done' ? 'x' : it.status === 'in_progress' ? '>' : ' '}] ${it.content}`);
  return [
    `# 任务计划`,
    '',
    `- **任务**: ${taskId}`,
    `- **更新**: ${now.toISOString()}`,
    `- **进度**: ${done}/${items.length}`,
    '',
    '## 清单',
    '',
    ...(lines.length > 0 ? lines : ['（清单为空）']),
    '',
  ].join('\n');
}

function ensureIgnored(workingDir: string): void {
  // .muster/ 不混入 approval checkpoint / 轮末提交——worktree .gitignore 缺就补一行
  const gitignore = path.join(workingDir, '.gitignore');
  try {
    const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
    if (!existing.split('\n').some((l) => l.trim() === '.muster/')) {
      writeFileSync(gitignore, `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}.muster/\n`, 'utf8');
    }
  } catch { /* gitignore 维护失败不阻断镜像 */ }
}

/**
 * 计划活文档 S1：向执行现场镜像 task_plan.md（workingDir 即任务 worktree）。
 * 无 workingDir / 写失败一律静默跳过——镜像是对用户可见的增强，草稿纸本体在 MUSTER_HOME。
 */
export function mirrorTaskPlan(workingDir: string | null | undefined, taskId: string, items: TodoItem[]): void {
  if (!workingDir || !existsSync(workingDir)) return;
  try {
    const dir = path.join(workingDir, '.muster');
    mkdirSync(dir, { recursive: true });
    ensureIgnored(workingDir);
    atomicWrite(path.join(dir, 'task_plan.md'), renderTaskPlanMarkdown(taskId, items));
  } catch { /* 镜像失败不影响草稿纸主功能 */ }
}

export const TODO_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'todo_read',
      description: '读取当前任务的工作清单（你的执行草稿纸：列出的待办与完成状态）。开工前、忘记进度时读它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        '整体覆写当前任务的工作清单。items 为 [{content, status}]，status ∈ pending|in_progress|done。用于：开工时列计划、推进时更新状态、完成时勾掉。一次最多 50 条。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '完整清单（整体替换，非增量）',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '待办内容（≤200 字）' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: '状态' },
              },
              required: ['content', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
  },
];

export async function todoReadHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const taskId = resolveTodoTaskId(ctx);
  if (!taskId) return { toolCallId: call.id, name: call.name, content: '当前无任务上下文（taskId 缺失），todo 清单不可用。' };
  return { toolCallId: call.id, name: call.name, content: renderTodo(readTodoList(taskId)) };
}

export async function todoWriteHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const taskId = resolveTodoTaskId(ctx);
  if (!taskId) return { toolCallId: call.id, name: call.name, content: '当前无任务上下文（taskId 缺失），todo 清单不可用。' };
  const raw = call.args.items;
  if (!Array.isArray(raw)) return { toolCallId: call.id, name: call.name, content: '错误：items 必须是数组 [{content, status}]' };
  const saved = writeTodoList(taskId, raw as TodoItem[]);
  // 计划活文档 S1：镜像到执行现场 + 实时事件（看板进程分区免轮询）；两者失败均不影响草稿纸
  mirrorTaskPlan(ctx.workingDir, taskId, saved);
  try {
    realtime.publish({
      id: `ev_todo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'task.todo_update',
      taskId,
      occurredAt: new Date().toISOString(),
      payload: { items: saved, done: saved.filter((it) => it.status === 'done').length, total: saved.length },
    });
  } catch { /* 事件失败吞 */ }
  return { toolCallId: call.id, name: call.name, content: `已保存 ${saved.length} 条：\n${renderTodo(saved)}` };
}
