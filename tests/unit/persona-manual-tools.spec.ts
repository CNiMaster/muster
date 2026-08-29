/**
 * 批次 E2（专家知识库工程）单元测试：
 * 1. readPersonaManualSection：按节名读手册正文（归一比对/缺失 null/实时读盘）
 * 2. personaManualCatalog：知识节目录排除身份三节+能力五节
 * 3. read_persona_manual 工具：按任务穿戴人设取节/无人设提示/节名纠错带目录
 * 4. assembleContext：CLI 注入路径行 / API 注入工具提示；无人设不注入
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from '../integration/setup';
import { setDbForTest } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import {
  getPersona,
  readPersonaManualSection,
  personaManualCatalog,
  parsePersonaFile,
} from '../../src/server/domain/persona-library';
import { readPersonaManualHandler } from '../../src/server/executors/tools/persona-tools';
import { BEE_TOOL_ALLOWLIST } from '../../src/server/domain/tool-tier';
import { assembleContext } from '../../src/server/executors/context';
import type { DB } from '../../src/server/db/client';
import type { ToolContext } from '../../src/server/executors/tools/registry';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

describe('readPersonaManualSection / personaManualCatalog', () => {
  it('按节名读正文，归一比对，缺失返回 null', () => {
    const p = getPersona('product/nexus-strategy');
    expect(p).not.toBeNull();
    const hit = readPersonaManualSection(p!, '策略基础');
    expect(hit).not.toBeNull();
    expect(hit!.length).toBeGreaterThan(50);
    // 变体写法（前后空格）也命中
    expect(readPersonaManualSection(p!, ' 策略基础 ')).not.toBeNull();
    expect(readPersonaManualSection(p!, '不存在的节')).toBeNull();
  });

  it('目录排除身份三节与能力五节，只留知识节', () => {
    const VARIANT = `---
name: 目录专家
description: x
---

## 你的身份与记忆

身份

## 关键规则

- 规则

## 技术交付物

- 交付物

## 领域专业知识

知识正文

## 学习与记忆

经验
`;
    const p = parsePersonaFile('dev/catalog', 'dev', VARIANT)!;
    expect(personaManualCatalog(p).map((s) => s.title)).toEqual(['领域专业知识', '学习与记忆']);
    // nexus-strategy 无身份/能力节 → 目录≈全量
    const nexus = getPersona('product/nexus-strategy')!;
    expect(personaManualCatalog(nexus).length).toBeGreaterThanOrEqual(20);
  });
});

describe('read_persona_manual 工具', () => {
  let fixtureSeq = 0;
  function fixture(personaId?: string) {
    fixtureSeq += 1;
    const c = restoreWorkbench(db, { id: `wb_pm_${fixtureSeq}`, name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const project = createProject(db, {
      companyId: c.id,
      name: 'p',
      rootDir: makeTempGitRepo(),
      firstAgentId: lead.id,
      initialState: 'active',
    });
    const task = createTask(db, {
      projectId: project.id,
      assigneeAgentId: lead.id,
      title: '戴人设任务',
      ...(personaId ? { personaId } : {}),
    });
    return { task };
  }

  const ctxFor = (taskId: string): ToolContext =>
    ({ workingDir: '/tmp', taskId, toolRegistry: { resolve: () => undefined } }) as unknown as ToolContext;

  it('按任务穿戴人设读取指定节', async () => {
    const { task } = fixture('product/nexus-strategy');
    const res = await readPersonaManualHandler(
      { id: 'c1', name: 'read_persona_manual', args: { section: '策略基础' } },
      ctxFor(task.id),
    );
    expect(res.content).toContain('NEXUS');
    expect(res.content.length).toBeGreaterThan(50);
  });

  it('无人设任务明确提示；节名纠错带可用目录', async () => {
    const { task } = fixture();
    const miss = await readPersonaManualHandler(
      { id: 'c2', name: 'read_persona_manual', args: { section: '策略基础' } },
      ctxFor(task.id),
    );
    expect(miss.content).toContain('没有穿戴人设');

    const { task: task2 } = fixture('product/nexus-strategy');
    const bad = await readPersonaManualHandler(
      { id: 'c3', name: 'read_persona_manual', args: { section: '乱写的节' } },
      ctxFor(task2.id),
    );
    expect(bad.content).toContain('可用节名');
    expect(bad.content).toContain('策略基础');
  });

  it('蜂档白名单收录（读自己手册与 read_file 同安全级）', () => {
    expect(BEE_TOOL_ALLOWLIST.has('read_persona_manual')).toBe(true);
  });
});

describe('assembleContext 手册渐进披露注入', () => {
  function fixtureWithPersona() {
    const c = restoreWorkbench(db, { id: 'wb_ctx_1', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const project = createProject(db, {
      companyId: c.id,
      name: 'p',
      rootDir: makeTempGitRepo(),
      firstAgentId: lead.id,
      initialState: 'active',
    });
    const task = createTask(db, {
      projectId: project.id,
      assigneeAgentId: lead.id,
      title: '手册注入',
      personaId: 'product/nexus-strategy',
    });
    return { task };
  }

  it('CLI 执行器注入目录+文件绝对路径', () => {
    const { task } = fixtureWithPersona();
    const assembled = assembleContext(db, task, { executorKind: 'cli' });
    expect(assembled.systemPrompt).toContain('# 你的专业手册');
    expect(assembled.systemPrompt).toContain('nexus-strategy.md');
    expect(assembled.systemPrompt).toContain('## 节标题定位');
    expect(assembled.systemPrompt).not.toContain('read_persona_manual');
  });

  it('API 执行器注入目录+工具提示', () => {
    const { task } = fixtureWithPersona();
    const assembled = assembleContext(db, task, { executorKind: 'api' });
    expect(assembled.systemPrompt).toContain('# 你的专业手册');
    expect(assembled.systemPrompt).toContain('read_persona_manual');
    expect(assembled.systemPrompt).not.toContain('nexus-strategy.md');
  });
});
