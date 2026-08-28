/**
 * capability parity 批次 A3：todo_read / todo_write builtin 单测。
 * 覆盖：task 隔离存储/整体替换语义/条数与长度夹紧/损坏文件容错/无任务上下文提示/handler 层。
 * 计划活文档 S1：task_plan.md 现场镜像（双写/gitignore 防污染/截断同步/降级跳过）。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mirrorTaskPlan, readTodoList, renderTaskPlanMarkdown, writeTodoList, todoReadHandler, todoWriteHandler } from '../../src/server/executors/tools/todo-tools';
import type { ToolContext } from '../../src/server/executors/tools/registry';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'muster-todo-'));
}

function makeCtx(taskId: string | null): ToolContext {
  return { workingDir: '/wt', toolRegistry: null as unknown as ToolContext['toolRegistry'], taskId: taskId ?? undefined } as ToolContext;
}

describe('readTodoList / writeTodoList（核心）', () => {
  it('写后读回：整体替换语义（第二次写覆盖第一次）', () => {
    const home = tmpHome();
    writeTodoList('t1', [{ content: '第一步', status: 'done' }, { content: '第二步', status: 'pending' }], home);
    expect(readTodoList('t1', home)).toEqual([{ content: '第一步', status: 'done' }, { content: '第二步', status: 'pending' }]);
    writeTodoList('t1', [{ content: '新清单', status: 'in_progress' }], home);
    expect(readTodoList('t1', home)).toEqual([{ content: '新清单', status: 'in_progress' }]);
  });

  it('task 隔离：不同 taskId 互不可见', () => {
    const home = tmpHome();
    writeTodoList('t1', [{ content: 'A 的清单', status: 'pending' }], home);
    expect(readTodoList('t2', home)).toEqual([]);
    expect(readTodoList('t1', home)[0]!.content).toBe('A 的清单');
  });

  it('夹紧：非法 status 归 pending、空 content 剔除、超长截断、条数 cap 50', () => {
    const home = tmpHome();
    const many = Array.from({ length: 60 }, (_, i) => ({ content: `项${i}`, status: 'pending' }));
    writeTodoList('t1', [
      { content: 'x'.repeat(500), status: 'pending' },
      { content: '   ', status: 'done' },
      { content: 'ok', status: 'weird' as 'pending' },
      ...many,
    ], home);
    const saved = readTodoList('t1', home);
    expect(saved.length).toBe(50);
    expect(saved[0]!.content.length).toBe(200);
    expect(saved.some((it) => it.content === 'ok')).toBe(true);
    expect(saved.find((it) => it.content === 'ok')!.status).toBe('pending');
  });

  it('容错：文件不存在/损坏 JSON/非数组结构 → 空清单', () => {
    const home = tmpHome();
    expect(readTodoList('missing', home)).toEqual([]);
    fs.mkdirSync(path.join(home, 'todo'), { recursive: true });
    fs.writeFileSync(path.join(home, 'todo', 'bad.json'), '{broken');
    expect(readTodoList('bad', home)).toEqual([]);
    fs.writeFileSync(path.join(home, 'todo', 'obj.json'), '{"not":"array"}');
    expect(readTodoList('obj', home)).toEqual([]);
  });
});

describe('handler 层', () => {
  it('无任务上下文：返回提示而非报错', async () => {
    const r = await todoReadHandler({ id: 't1', name: 'todo_read', args: {} }, makeCtx(null));
    expect(r.content).toContain('taskId 缺失');
    const w = await todoWriteHandler({ id: 't2', name: 'todo_write', args: { items: [] } }, makeCtx(null));
    expect(w.content).toContain('taskId 缺失');
  });

  it('读空清单提示建清单；写入后渲染勾选视图', async () => {
    process.env.MUSTER_HOME = tmpHome();
    try {
      const ctx = makeCtx('task-x');
      const empty = await todoReadHandler({ id: 't3', name: 'todo_read', args: {} }, ctx);
      expect(empty.content).toContain('清单为空');
      const w = await todoWriteHandler({ id: 't4', name: 'todo_write', args: { items: [
        { content: '调研', status: 'done' },
        { content: '写码', status: 'in_progress' },
        { content: '测试', status: 'pending' },
      ] } }, ctx);
      expect(w.content).toContain('[x] 调研');
      expect(w.content).toContain('[>] 写码');
      expect(w.content).toContain('[ ] 测试');
      expect(w.content).toContain('完成 1/3');
      const r = await todoReadHandler({ id: 't5', name: 'todo_read', args: {} }, ctx);
      expect(r.content).toContain('[>] 写码');
    } finally {
      delete process.env.MUSTER_HOME;
    }
  });

  it('items 非数组报错', async () => {
    process.env.MUSTER_HOME = tmpHome();
    try {
      const r = await todoWriteHandler({ id: 't6', name: 'todo_write', args: { items: 'nope' } }, makeCtx('task-y'));
      expect(r.content).toContain('items 必须是数组');
    } finally {
      delete process.env.MUSTER_HOME;
    }
  });
});

describe('计划活文档 S1：task_plan.md 现场镜像', () => {
  /** 复审 P1：镜像白名单=只写 MUSTER_HOME/worktrees/ 之下的任务 worktree——测试目录须落在其内。 */
  function tmpWorktree(): string {
    const home = process.env.MUSTER_HOME ?? `${process.env.HOME ?? '/tmp'}/.muster`;
    const dir = path.join(home, 'worktrees', `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 独立临时目录（白名单外——模拟项目根/讨论目录，镜像必须拒绝写入）。 */
  function tmpOutside(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'muster-out-'));
  }

  function withHome<T>(fn: () => T): T {
    const prev = process.env.MUSTER_HOME;
    process.env.MUSTER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-mirror-'));
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.MUSTER_HOME;
      else process.env.MUSTER_HOME = prev;
    }
  }

  it('mirrorTaskPlan：写入 worktree/.muster/task_plan.md，含三态标记与进度', () => {
    withHome(() => {
      const wt = tmpWorktree();
      const items = [
        { content: '调研', status: 'done' as const },
        { content: '写码', status: 'in_progress' as const },
        { content: '测试', status: 'pending' as const },
      ];
      mirrorTaskPlan(wt, 'task-m', items);
      const md = fs.readFileSync(path.join(wt, '.muster', 'task_plan.md'), 'utf8');
      expect(md).toContain('# 任务计划');
      expect(md).toContain('task-m');
      expect(md).toContain('- [x] 调研');
      expect(md).toContain('- [>] 写码');
      expect(md).toContain('- [ ] 测试');
      expect(md).toContain('1/3');
    });
  });

  it('复审 P1 白名单：worktree 根之外的目录（项目根/讨论目录）绝不写入、不改 .gitignore', () => {
    withHome(() => {
      const outside = tmpOutside();
      mirrorTaskPlan(outside, 'task-x', [{ content: 'a', status: 'pending' }]);
      expect(fs.existsSync(path.join(outside, '.muster'))).toBe(false);
      expect(fs.existsSync(path.join(outside, '.gitignore'))).toBe(false);
    });
  });

  it('gitignore 防污染：首写追加 .muster/，二次写不重复', () => {
    withHome(() => {
      const wt = tmpWorktree();
      mirrorTaskPlan(wt, 'task-g', [{ content: 'a', status: 'pending' }]);
      mirrorTaskPlan(wt, 'task-g', [{ content: 'b', status: 'done' }]);
      const gi = fs.readFileSync(path.join(wt, '.gitignore'), 'utf8');
      expect(gi.split('\n').filter((l) => l.trim() === '.muster/').length).toBe(1);
    });
  });

  it('双写一致：writeTodoList 夹紧（cap 50）后镜像反映夹紧结果', () => {
    withHome(() => {
      const wt = tmpWorktree();
      const many = Array.from({ length: 60 }, (_, i) => ({ content: `项${i}`, status: 'pending' as const }));
      const saved = writeTodoList('task-cap', many, process.env.MUSTER_HOME!);
      mirrorTaskPlan(wt, 'task-cap', saved);
      const md = fs.readFileSync(path.join(wt, '.muster', 'task_plan.md'), 'utf8');
      expect(saved.length).toBe(50);
      expect(md).toContain('0/50');
      expect(md).not.toContain('项59');
    });
  });

  it('降级：workingDir 缺失/不存在时静默跳过不抛错', () => {
    expect(() => mirrorTaskPlan(null, 'task-x', [])).not.toThrow();
    expect(() => mirrorTaskPlan('/nonexistent-wt-xyz', 'task-x', [{ content: 'a', status: 'pending' }])).not.toThrow();
  });

  it('handler 集成：todo_write 后现场出现 task_plan.md（worktree 白名单内）', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-hand-'));
    process.env.MUSTER_HOME = home;
    const wt = path.join(home, 'worktrees', 'wt-h');
    fs.mkdirSync(wt, { recursive: true });
    try {
      const ctx = { ...makeCtx('task-h'), workingDir: wt } as ToolContext;
      await todoWriteHandler({ id: 't7', name: 'todo_write', args: { items: [{ content: '现场可见', status: 'in_progress' }] } }, ctx);
      const md = fs.readFileSync(path.join(wt, '.muster', 'task_plan.md'), 'utf8');
      expect(md).toContain('- [>] 现场可见');
    } finally {
      delete process.env.MUSTER_HOME;
    }
  });

  it('renderTaskPlanMarkdown：空清单占位不抛错', () => {
    const md = renderTaskPlanMarkdown('task-e', []);
    expect(md).toContain('（清单为空）');
    expect(md).toContain('0/0');
  });
});
