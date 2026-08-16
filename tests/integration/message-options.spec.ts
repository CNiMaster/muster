/**
 * 批次 D2：消息级执行选项
 * - mode/model/thinking 随消息落库（options_json）并写入 Task inputProtocol
 * - 计划模式给派发内容加【计划模式】只读指令前缀
 * - 前端思考档位别名 med 归一为 medium
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {  makeTestDb, createNovelCompany } from './setup';
import type { DB } from '../../src/server/db/client';
import { createProject } from '../../src/server/domain/project';
import { postUserMessage, listMessages } from '../../src/server/domain/conversation';
import { listTasks } from '../../src/server/domain/task';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let projectId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  const project = createProject(db, {
    companyId: r.company.id,
    name: 'p',
    rootDir: '/tmp/msg-opt',
    firstAgentId: r.agents.lead.id,
    initialState: 'active',
  });
  projectId = project.id;
});

describe('message options', () => {
  it('mode/model/thinking 落库并进 inputProtocol；med 归一 medium', () => {
    const { task } = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: projectId,
      content: '直接开工',
      options: { mode: 'ask-always', model: 'gpt-5', thinking: 'med' },
    });
    const stored = listMessages(db, 'project', projectId)[0]!;
    expect(stored.options).toEqual({ mode: 'ask-always', model: 'gpt-5', thinking: 'medium' });

    const dispatched = listTasks(db, projectId).find((t) => t.id === task!.id)!;
    expect(dispatched.inputProtocol.mode).toBe('ask-always');
    expect(dispatched.inputProtocol.model).toBe('gpt-5');
    expect(dispatched.inputProtocol.thinking).toBe('medium');
    expect(dispatched.inputProtocol.content as string).not.toContain('计划模式');
  });

  it('计划模式：派发内容加只读规划前缀，inputProtocol.mode=plan', () => {
    const { task } = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: projectId,
      content: '设计重构方案',
      options: { mode: 'plan' },
    });
    const dispatched = listTasks(db, projectId).find((t) => t.id === task!.id)!;
    expect(dispatched.inputProtocol.mode).toBe('plan');
    const content = dispatched.inputProtocol.content as string;
    expect(content.startsWith('【计划模式】')).toBe(true);
    expect(content).toContain('设计重构方案');
    // 原消息展示文案保持用户原文
    expect(listMessages(db, 'project', projectId)[0]!.content).toBe('设计重构方案');
  });

  it('非法 thinking 档位被忽略', () => {
    const { task } = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: projectId,
      content: 'x',
      options: { thinking: 'ultra' as 'high' },
    });
    const dispatched = listTasks(db, projectId).find((t) => t.id === task!.id)!;
    expect(dispatched.inputProtocol.thinking).toBeUndefined();
  });
});
