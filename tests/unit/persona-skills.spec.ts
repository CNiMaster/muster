/**
 * 批次 H（人设武器）单元/集成测试：
 * 1. frontmatter skills 解析（逗号与 YAML 风格）
 * 2. updateUserPersona 重写保留 skills（编辑不丢装备）
 * 3. resolveTaskSkills：穿声明人设 → persona 源装载；优先级 persona > field；缺文件标 missing；
 *    无人设任务不受影响
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from '../integration/setup';
import { setDbForTest } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { parsePersonaFile, updateUserPersona, getPersona, parsePersonaFile as parse, USER_PERSONAS_ROOT } from '../../src/server/domain/persona-library';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolveTaskSkills } from '../../src/server/domain/capability-binding';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

describe('frontmatter skills 解析', () => {
  it('逗号分隔与 YAML 风格均可解析', () => {
    const A = `---
name: 带枪专家
description: x
skills: code-review-and-quality, test-driven-development
---

## 你的身份与记忆

身份
`;
    const p = parse('dev/armed', 'dev', A)!;
    expect(p.skills).toEqual(['code-review-and-quality', 'test-driven-development']);
    expect(p.tools).toEqual([]);

    const B = A.replace('skills: code-review-and-quality, test-driven-development', 'skills: [code-review-and-quality]');
    expect(parse('dev/armed2', 'dev', B)!.skills).toEqual(['code-review-and-quality']);
  });

  it('无 skills 声明时空数组（向后兼容）', () => {
    const p = parsePersonaFile('dev/bare', 'dev', '---\nname: 裸专家\ndescription: x\n---\n\n## 你的身份与记忆\n\n身\n');
    expect(p!.skills).toEqual([]);
  });
});

describe('updateUserPersona skills 保留', () => {
  it('patch 未带 skills 时原声明保留并写回 frontmatter', () => {
    const c = restoreWorkbench(db, { id: `wb_hs_${Math.random().toString(36).slice(-6)}`, name: 'co' });
    void c;
    // 直接造一个用户人设文件（走 writeUserPersonaFile 的同款路径太绕；用 writeFileSync 等价链路：updateUserPersona 需先有文件）
    const dir = `${USER_PERSONAS_ROOT}/specialized`;
    mkdirSync(dir, { recursive: true });
    const id = 'user/specialized/skill-preserved';
    writeFileSync(`${dir}/skill-preserved.md`, [
      '---',
      'name: 保留专家',
      'description: x',
      'emoji: 🧬',
      'color: "#7c5cff"',
      'skills: code-review-and-quality',
      '---',
      '',
      '# 保留专家',
      '',
      '## 你的身份与记忆',
      '',
      '身份',
      '',
      '## 核心使命',
      '',
      '使命',
      '',
      '## 关键规则',
      '',
      '- 规则',
      '',
    ].join('\n'), 'utf8');

    updateUserPersona(id, { soul: '新身份' });
    const updated = getPersona(id)!;
    expect(updated.skills).toEqual(['code-review-and-quality']);

    // 显式覆盖也生效
    updateUserPersona(id, { skills: ['debugging-and-error-recovery'] });
    expect(getPersona(id)!.skills).toEqual(['debugging-and-error-recovery']);
  });
});

describe('resolveTaskSkills persona 源', () => {
  function seed(personaId?: string) {
    const c = restoreWorkbench(db, { id: `wb_rs_${Math.random().toString(36).slice(-6)}`, name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
    const task = createTask(db, { projectId: p.id, title: '装载', assigneeAgentId: lead.id, ...(personaId ? { personaId } : {}) });
    return { task };
  }

  it('穿声明人设 → bundled skill 以 persona 源装载；缺文件标 missing', () => {
    // 真实人设 + 真实 bundled skill：给 marketing 内容创作者临时造一个带 skills 的 user 人设更可控，
    // 但 parse 走双根；此处用 user 根人设文件（与保留用例同法）确保 skills 命中真实 bundled id。
    const dir = `${USER_PERSONAS_ROOT}/dev`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/armed-runner.md`, [
      '---',
      'name: 带枪执行者',
      'description: x',
      'emoji: 🧬',
      'color: "#7c5cff"',
      'skills: code-review-and-quality, not-exist-anywhere',
      '---',
      '',
      '# 带枪执行者',
      '',
      '## 你的身份与记忆',
      '',
      '身份',
      '',
    ].join('\n'), 'utf8');

    const { task } = seed('user/dev/armed-runner');
    const resolved = resolveTaskSkills(db, task);
    const byId = new Map(resolved.map((r) => [r.skillId, r]));
    const hit = byId.get('code-review-and-quality');
    expect(hit?.source).toBe('persona');
    expect(hit?.status).toBe('loaded');
    expect(hit?.reason).toContain('带枪执行者');
    expect(byId.get('not-exist-anywhere')?.status).toBe('missing');
  });

  it('无人设任务不产生 persona 源', () => {
    const { task } = seed();
    const resolved = resolveTaskSkills(db, task);
    expect(resolved.every((r) => r.source !== 'persona')).toBe(true);
  });
});
