/**
 * Batch 11 集成测试：Muster 工具循环框架 + file-tools。
 * - file-tools 读写编辑、路径越界拒绝、done 解析
 * - tool-loop 多轮调用、maxToolCalls 上限、done 终止
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeFileTool, FILE_TOOLS, type ToolCall } from '../../src/server/executors/tools/file-tools';
import { runToolLoop, type ChatMessage, type ModelCallResult, type CallModelFn } from '../../src/server/executors/tool-loop';

let workdir: string;
let tmpRoots: string[] = [];

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'muster-tool-'));
  tmpRoots.push(workdir);
});

afterEach(() => {
  for (const root of tmpRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpRoots = [];
});

describe('Batch 11.1 file-tools', () => {
  it('FILE_TOOLS 含 read_file/write_file/edit_file/list_files/done', () => {
    const names = FILE_TOOLS.map((t) => t.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('list_files');
    expect(names).toContain('done');
  });

  it('write_file 写入 worktree', async () => {
    const r = await executeFileTool(
      { id: '1', name: 'write_file', args: { path: 'a.txt', content: 'hello' } },
      workdir,
    );
    expect(r.content).toMatch(/已写入/);
    expect(readFileSync(join(workdir, 'a.txt'), 'utf8')).toBe('hello');
  });

  it('read_file 读取内容', async () => {
    writeFileSync(join(workdir, 'b.txt'), 'world');
    const r = await executeFileTool(
      { id: '2', name: 'read_file', args: { path: 'b.txt' } },
      workdir,
    );
    expect(r.content).toBe('world');
  });

  it('read_file 路径越界被拒绝', async () => {
    const r = await executeFileTool(
      { id: '3', name: 'read_file', args: { path: '../../../etc/passwd' } },
      workdir,
    );
    expect(r.content).toMatch(/路径越界/);
  });

  it('write_file 路径越界被拒绝', async () => {
    const r = await executeFileTool(
      { id: '4', name: 'write_file', args: { path: '/etc/x', content: 'x' } },
      workdir,
    );
    expect(r.content).toMatch(/路径越界/);
  });

  it('write_file 只读目录被拒绝', async () => {
    const ro = mkdtempSync(join(tmpdir(), 'muster-ro-'));
    tmpRoots.push(ro);
    const r = await executeFileTool(
      { id: '5', name: 'write_file', args: { path: 'x', content: 'x' } },
      ro,
      [ro], // ro 本身被标为只读
    );
    expect(r.content).toMatch(/只读/);
  });

  it('edit_file 精确替换', async () => {
    writeFileSync(join(workdir, 'c.md'), '# 标题\n\n正文\n');
    const r = await executeFileTool(
      { id: '6', name: 'edit_file', args: { path: 'c.md', old_text: '正文', new_text: '新正文' } },
      workdir,
    );
    expect(r.content).toMatch(/已编辑/);
    expect(readFileSync(join(workdir, 'c.md'), 'utf8')).toBe('# 标题\n\n新正文\n');
  });

  it('edit_file 多处匹配拒绝', async () => {
    writeFileSync(join(workdir, 'd.md'), 'a a a');
    const r = await executeFileTool(
      { id: '7', name: 'edit_file', args: { path: 'd.md', old_text: 'a', new_text: 'b' } },
      workdir,
    );
    expect(r.content).toMatch(/必须唯一|匹配.*处/);
  });

  it('list_files 列出目录', async () => {
    writeFileSync(join(workdir, 'x.txt'), 'x');
    mkdirSync(join(workdir, 'sub'));
    const r = await executeFileTool(
      { id: '8', name: 'list_files', args: { dir: '.' } },
      workdir,
    );
    expect(r.content).toContain('x.txt');
    expect(r.content).toContain('[DIR]');
    expect(r.content).toContain('sub');
  });

  it('done 返回合法 AgentRunResult', async () => {
    const r = await executeFileTool(
      { id: '9', name: 'done', args: { outcome: 'completed', summary: 'ok', outboundTasks: [], artifacts: [] } },
      workdir,
    );
    expect(r.doneResult).toBeDefined();
    expect(r.doneResult!.outcome).toBe('completed');
    expect(r.doneResult!.summary).toBe('ok');
  });

  it('done 非法 outcome 被拒绝', async () => {
    const r = await executeFileTool(
      { id: '10', name: 'done', args: { outcome: 'xxx', summary: '' } },
      workdir,
    );
    expect(r.doneResult).toBeUndefined();
    expect(r.content).toMatch(/校验失败/);
  });
});

describe('Batch 11.2 tool-loop 驱动器', () => {
  it('单轮 done：模型立即返回 done 工具', async () => {
    const callModel: CallModelFn = async () => ({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'done',
              arguments: JSON.stringify({
                outcome: 'completed',
                summary: 'done immediately',
                outboundTasks: [],
                artifacts: [],
              }),
            },
          },
        ],
      },
      usage: { promptTokens: 100, completionTokens: 50, cachedTokens: 0 },
    });

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'do it' }],
      callModel,
      workingDir: workdir,
      maxToolCalls: 10,
      timeoutMs: 5000,
      model: 'gpt-4o',
    });

    expect(result.result).toBeDefined();
    expect(result.result!.outcome).toBe('completed');
    expect(result.result!.summary).toBe('done immediately');
    expect(result.rounds).toBe(1);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
  });

  it('多轮：write_file → done', async () => {
    let round = 0;
    const callModel: CallModelFn = async (messages) => {
      round++;
      if (round === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tc1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'out.txt', content: 'generated' }),
                },
              },
            ],
          },
          usage: { promptTokens: 100, completionTokens: 80, cachedTokens: 0 },
        };
      }
      // 第二轮：检查 tool result 后返回 done
      const lastMsg = messages[messages.length - 1];
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'tc2',
              type: 'function',
              function: {
                name: 'done',
                arguments: JSON.stringify({
                  outcome: 'completed',
                  summary: 'file written',
                  outboundTasks: [],
                  artifacts: [{ path: 'out.txt', kind: 'chapter', operation: 'create' }],
                }),
              },
            },
          ],
        },
        usage: { promptTokens: 150, completionTokens: 60, cachedTokens: 0 },
      };
      void lastMsg;
    };

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'write a file' }],
      callModel,
      workingDir: workdir,
      maxToolCalls: 10,
      timeoutMs: 5000,
      model: 'gpt-4o',
    });

    expect(result.result).toBeDefined();
    expect(result.result!.summary).toBe('file written');
    expect(result.rounds).toBe(2);
    expect(result.usage.inputTokens).toBe(250); // 100 + 150
    expect(readFileSync(join(workdir, 'out.txt'), 'utf8')).toBe('generated');
  });

  it('maxToolCalls 上限：达到上限无 done 返回 null', async () => {
    const callModel: CallModelFn = async () => ({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc', type: 'function', function: { name: 'list_files', arguments: '{}' } },
        ],
      },
      usage: { promptTokens: 50, completionTokens: 10, cachedTokens: 0 },
    });

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'loop' }],
      callModel,
      workingDir: workdir,
      maxToolCalls: 3,
      timeoutMs: 5000,
      model: 'gpt-4o',
    });

    expect(result.result).toBeNull();
    expect(result.rounds).toBe(3);
  });
});
