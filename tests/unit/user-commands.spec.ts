/**
 * capability parity 批次 D3：用户命令域——存储/frontmatter/展开/$ARGUMENTS。
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listUserCommands, saveUserCommand, getUserCommand, deleteUserCommand, expandCommand, commandsRoot } from '../../src/server/domain/user-commands';

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-cmd-'));
  process.env.MUSTER_HOME = dir;
  return dir;
}

afterEach(() => { delete process.env.MUSTER_HOME; });

describe('user-commands', () => {
  it('保存→列表→读取→删除 全链；frontmatter 绑定保真', () => {
    tmpHome();
    saveUserCommand({ token: 'review-pr', description: '审查改动', mode: 'plan', template: '请审查：$ARGUMENTS' });
    expect(listUserCommands().map((c) => c.token)).toEqual(['review-pr']);
    const cmd = getUserCommand('review-pr');
    expect(cmd.mode).toBe('plan');
    expect(cmd.description).toBe('审查改动');
    deleteUserCommand('review-pr');
    expect(listUserCommands()).toHaveLength(0);
  });

  it('expandCommand：$ARGUMENTS 替换；无占位追加；绑定选项透出', () => {
    tmpHome();
    saveUserCommand({ token: 'with-args', template: '目标：$ARGUMENTS' });
    const r1 = expandCommand(getUserCommand('with-args'), '登录页性能');
    expect(r1.content).toBe('目标：登录页性能');
    saveUserCommand({ token: 'no-ph', mode: 'exec', template: '跑一遍全量测试' });
    const r2 = expandCommand(getUserCommand('no-ph'), '补充参数');
    expect(r2.content).toContain('跑一遍全量测试');
    expect(r2.content).toContain('补充参数');
    expect(r2.options.mode).toBe('exec');
  });

  it('非法 token/空模板拒绝；空根目录列表为空；未知命令读取 404', () => {
    tmpHome();
    expect(() => saveUserCommand({ token: 'Bad Token', template: 'x' })).toThrow();
    expect(() => saveUserCommand({ token: 'ok', template: '  ' })).toThrow();
    expect(listUserCommands()).toHaveLength(0);
    expect(() => getUserCommand('missing')).toThrow();
  });

  it('坏文件跳过不影响其余命令枚举', () => {
    const home = tmpHome();
    saveUserCommand({ token: 'good', template: 'ok' });
    fs.writeFileSync(path.join(commandsRoot(), '_bad.md'), '非法 token 文件应被跳过');
    expect(listUserCommands().map((c) => c.token)).toEqual(['good']);
  });
});
