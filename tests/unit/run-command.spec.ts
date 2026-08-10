/**
 * run_command 工具单测（P1：API 执行器补命令能力）。
 *
 * 验证三重防护：
 * 1. 黑名单：灾难性命令（rm -rf /、eval、dd of=）硬拒绝，不执行
 * 2. 风险分级审批：git-push/system-install 等 HIGH_RISK 命令转审批 action，permissionGuard 拒绝时不执行
 * 3. 实际执行：普通命令在工作目录内执行，返回 stdout
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool, createBuiltinToolRegistry, type ToolCall, type ToolContext, type PermissionGuard } from '../../src/server/executors/tools/registry';

describe('run_command 工具（API 执行器补命令能力）', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'muster-bash-'));
    writeFileSync(join(workDir, 'hello.txt'), 'world');
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function makeCtx(guard?: PermissionGuard): ToolContext {
    return { workingDir: workDir, readonlyDirs: [], toolRegistry: createBuiltinToolRegistry(), permissionGuard: guard };
  }

  it('普通命令在工作目录内执行，返回 stdout', async () => {
    const call: ToolCall = { id: 'c1', name: 'run_command', args: { command: 'cat hello.txt' } };
    const result = await executeTool(call, makeCtx());
    expect(result.content.trim()).toBe('world');
  });

  it('命令带退出码信息', async () => {
    const call: ToolCall = { id: 'c1', name: 'run_command', args: { command: 'ls nonexistent-file-xyz' } };
    const result = await executeTool(call, makeCtx());
    expect(result.content).toContain('退出码');
  });

  it('黑名单命令硬拒绝，不执行', async () => {
    const cases = [
      'rm -rf /',
      'rm -rf $HOME',
      'eval "${PAYLOAD}"',
      'dd of=/dev/sda',
      'mkfs /dev/sda1',
      'git push --force origin main',
    ];
    for (const command of cases) {
      const call: ToolCall = { id: 'c', name: 'run_command', args: { command } };
      const result = await executeTool(call, makeCtx());
      expect(result.content).toContain('被拒绝');
    }
  });

  it('git push（非 force）走审批：permissionGuard 拒绝时不执行', async () => {
    const guard: PermissionGuard = (req) => {
      // git-push 是 HIGH_RISK，permissionGuard 收到后拒绝
      if (req.action === 'git-push') return { allowed: false, message: '需用户审批 git push' };
      return { allowed: true };
    };
    const call: ToolCall = { id: 'c1', name: 'run_command', args: { command: 'git push origin main' } };
    const result = await executeTool(call, makeCtx(guard));
    expect(result.content).toContain('需用户审批');
    expect(result.content).toContain('git-push');
  });

  it('npm install -g（system-install）走审批', async () => {
    const seenActions: string[] = [];
    const guard: PermissionGuard = (req) => {
      seenActions.push(req.action);
      return { allowed: false, message: '拒绝系统安装' };
    };
    const call: ToolCall = { id: 'c1', name: 'run_command', args: { command: 'npm install -g typescript' } };
    const result = await executeTool(call, makeCtx(guard));
    expect(seenActions).toContain('system-install');
    expect(result.content).toContain('需要用户审批');
  });

  it('credential-access 命令（访问 credentials.json）走审批', async () => {
    const seenActions: string[] = [];
    const guard: PermissionGuard = (req) => {
      seenActions.push(req.action);
      return { allowed: false, message: '拒绝访问凭据' };
    };
    // 用 credentials.json 而非 .ssh/（后者会被黑名单先拦）
    const call: ToolCall = { id: 'c1', name: 'run_command', args: { command: 'cat credentials.json' } };
    const result = await executeTool(call, makeCtx(guard));
    expect(seenActions).toContain('credential-access');
    expect(result.content).toContain('需要用户审批');
  });

  it('普通命令（run-command）无 permissionGuard 时直接执行', async () => {
    const call: ToolCall = { id: 'c1', name: 'run_command', args: { command: 'echo hello' } };
    const result = await executeTool(call, makeCtx()); // 无 guard
    expect(result.content.trim()).toBe('hello');
  });

  it('命令在 workDir 内运行（cwd 隔离）', async () => {
    const call: ToolCall = { id: 'c1', name: 'run_command', args: { command: 'pwd' } };
    const result = await executeTool(call, makeCtx());
    // macOS /tmp 是 /private/tmp 的符号链接，pwd 可能返回任一形式
    expect(result.content.trim()).toMatch(/muster-bash-/);
  });

  it('空命令报错', async () => {
    const call: ToolCall = { id: 'c1', name: 'run_command', args: { command: '' } };
    const result = await executeTool(call, makeCtx());
    expect(result.content).toContain('必填');
  });
});
