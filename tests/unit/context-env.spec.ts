import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { assembleContext } from '../../src/server/executors/context';
import { localTimezone } from '../../src/server/domain/tz';
import os from 'node:os';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('assembleContext 运行环境段（批次 A）', () => {
  it('注入当前日期、时区、操作系统架构与执行器类型', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_env_test', name: '工作台' });
    const agent = createAgent(db, {
      companyId: workbench.id,
      name: '工程师',
      role: 'engineer',
      responsibilities: '研发',
      systemPrompt: '稳健执行',
    });
    const project = createProject(db, { companyId: workbench.id, name: '测试项目' });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '测试任务' });

    const ctx = assembleContext(db, task, {
      executorKind: 'cli',
    });

    const sp = ctx.systemPrompt;
    expect(sp).toContain('# 运行环境');
    expect(sp).toContain(`运行平台：${process.platform}/${os.arch()}`);
    expect(sp).toContain('执行器类型：cli');
    expect(sp).toContain(`(${localTimezone()})`);

    // 格式形如：当前时间：2026-08-19 星期三 21:18 (Asia/Shanghai)
    expect(sp).toMatch(/当前时间：\d{4}-\d{2}-\d{2} 星期[一二三四五六日] \d{2}:\d{2}/);

    // 顺序验证：员工身份在运行环境之前
    expect(sp.indexOf('# 员工身份')).toBeLessThan(sp.indexOf('# 运行环境'));
  });

  it('轻量模式同样注入运行环境', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_env_light', name: '工作台' });
    const agent = createAgent(db, {
      companyId: workbench.id,
      name: '咨询师',
      role: 'advisor',
    });
    const project = createProject(db, { companyId: workbench.id, name: '轻量项目' });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '快速咨询' });

    const ctx = assembleContext(db, task, {
      executorKind: 'api',
      lightweight: true,
    });

    const sp = ctx.systemPrompt;
    expect(sp).toContain('# 运行环境');
    expect(sp).toContain('执行器类型：api');
    expect(sp).not.toContain('# 项目说明'); // 轻量模式跳过大段项目/章程
  });
});
