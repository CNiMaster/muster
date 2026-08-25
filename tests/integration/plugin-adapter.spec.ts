/**
 * B1 骨干集成测试：Plugin 适配器读侧。
 *
 * 验证 listPlugins 合并三个只读数据源（skill/tool/bridge）+ 数据库 plugin 表：
 * - skill 全量扫描（含嵌套目录 skills/system/<id>/）
 * - tool 从 tool_registry 表读取
 * - bridge 从 BRIDGE_ACTIONS 映射
 * - 数据库 plugin 表记录覆盖同 id 只读视图
 * - kind/status 过滤
 *
 * skill 扫描用受控临时目录，避免依赖项目真实 skills/ 内容。
 * tool 测试需要先 syncToolRegistry 入库。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { listPlugins, getPlugin, listBundledSkills } from '../../src/server/domain/plugin-adapter';
import { syncToolRegistry } from '../../src/server/domain/tool-registry';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let skillsRoot: string;
let toolsRoot: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  skillsRoot = mkdtempSync(join(tmpdir(), 'muster-skills-'));
  toolsRoot = mkdtempSync(join(tmpdir(), 'muster-tools-'));
});

afterEach(() => {
  tdb.close();
  for (const root of [skillsRoot, toolsRoot]) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function writeSkill(dir: string, id: string, frontmatter: Record<string, string>, body: string): void {
  mkdirSync(join(dir, id), { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  writeFileSync(join(dir, id, 'SKILL.md'), `---\n${fm}\n---\n${body}`);
}

function writeTool(
  dir: string,
  category: string,
  id: string,
  frontmatter: Record<string, string>,
  title: string,
): void {
  mkdirSync(join(dir, category), { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  writeFileSync(join(dir, category, `${id}.md`), `---\n${fm}\n---\n# ${title}\nbody`);
}

describe('listBundledSkills 扫描', () => {
  it('扫描一级 skill 目录并解析 frontmatter', () => {
    writeSkill(skillsRoot, 'idea-refine', { name: 'idea-refine', description: '打磨点子' }, '# 正文');
    const skills = listBundledSkills(skillsRoot);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('idea-refine');
    expect(skills[0].frontmatter.description).toBe('打磨点子');
    expect(skills[0].body).toContain('# 正文');
  });

  it('支持嵌套目录 skills/system/<id>/', () => {
    mkdirSync(join(skillsRoot, 'system', 'architect'), { recursive: true });
    writeFileSync(
      join(skillsRoot, 'system', 'architect', 'SKILL.md'),
      '---\nname: architect\ndescription: 架构师\n---\nbody',
    );
    const skills = listBundledSkills(skillsRoot);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('architect');
  });

  it('frontmatter 缺失 name 时回退父目录名', () => {
    mkdirSync(join(skillsRoot, 'no-fm-name'), { recursive: true });
    writeFileSync(join(skillsRoot, 'no-fm-name', 'SKILL.md'), '---\ndescription: 无 name\n---\nbody');
    const skills = listBundledSkills(skillsRoot);
    expect(skills[0].id).toBe('no-fm-name');
  });

  it('不存在目录返回空数组', () => {
    expect(listBundledSkills(join(skillsRoot, 'nonexistent'))).toEqual([]);
  });
});

describe('listPlugins 合并三源', () => {
  it('skill + tool + bridge 全部包装为 Plugin', () => {
    writeSkill(skillsRoot, 'my-skill', { name: 'my-skill', description: '测试 skill' }, 'body');
    writeTool(toolsRoot, 'document', 'pandoc', {
      id: 'pandoc',
      capability: 'document',
      implementation: 'local',
    }, 'Pandoc');
    syncToolRegistry(db, toolsRoot);

    const plugins = listPlugins(db, { skillsRoot });
    const kinds = plugins.map((p) => p.kind);
    expect(kinds).toContain('skill');
    expect(kinds).toContain('tool');
    expect(kinds).toContain('bridge-action');

    const skill = plugins.find((p) => p.id === 'skill:my-skill');
    expect(skill?.kind).toBe('skill');
    expect(skill?.source).toEqual({ kind: 'builtin' });
    expect(skill?.scope).toEqual({ level: 'platform' });
    expect(skill?.manifest.kind).toBe('skill');

    const tool = plugins.find((p) => p.id === 'tool:pandoc');
    expect(tool?.kind).toBe('tool');
    expect(tool?.manifest.kind).toBe('tool');

    const bridge = plugins.find((p) => p.id === 'bridge:progress');
    expect(bridge?.kind).toBe('bridge-action');
    expect(bridge?.manifest.kind).toBe('bridge-action');
  });

  it('bridge 含全部 12 个 action（H9c/J1 受托越界与借调；B1 管理域四件；C2 知识库两件）', () => {
    const plugins = listPlugins(db, { skillsRoot, kind: 'bridge-action' });
    const ids = plugins.map((p) => p.id).sort();
    expect(ids).toEqual(['bridge:borrow-specialist', 'bridge:elevated-command', 'bridge:knowledge-append', 'bridge:knowledge-query', 'bridge:notify', 'bridge:plugin-list', 'bridge:plugin-toggle', 'bridge:preview', 'bridge:progress', 'bridge:settings-get', 'bridge:settings-set', 'bridge:submit-review']);
  });

  it('bridge promptSection 含 curl 命令和参数说明', () => {
    const plugins = listPlugins(db, { skillsRoot, kind: 'bridge-action' });
    const submit = plugins.find((p) => p.id === 'bridge:submit-review');
    expect(submit?.manifest.kind).toBe('bridge-action');
    if (submit?.manifest.kind === 'bridge-action') {
      expect(submit.manifest.bridge.method).toBe('POST');
      expect(submit.manifest.bridge.promptSection).toContain('curl');
      expect(submit.manifest.bridge.promptSection).toContain('review_kind');
    }
  });

  it('kind 过滤只返回指定类型', () => {
    writeSkill(skillsRoot, 's1', { name: 's1', description: 'd' }, 'b');
    const skills = listPlugins(db, { skillsRoot, kind: 'skill' });
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((p) => p.kind === 'skill')).toBe(true);
  });

  it('status 过滤', () => {
    const available = listPlugins(db, { skillsRoot, status: 'available' });
    expect(available.every((p) => p.status === 'available')).toBe(true);
  });
});

describe('listPlugins 数据库优先', () => {
  it('plugin 表记录覆盖同 id 只读视图', () => {
    writeSkill(skillsRoot, 'overlap', { name: 'overlap', description: '原版' }, 'body');

    // 插入一条 plugin 表记录，id 与只读视图一致（skill:overlap）才能覆盖
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO plugin (id, name, kind, source_kind, source_ref, scope_level, scope_id, manifest_json, status, maturity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'skill:overlap',
      '数据库覆盖版',
      'skill',
      'workbench',
      'co_1',
      'workbench',
      'co_1',
      JSON.stringify({ kind: 'skill', skill: { body: 'db body' } }),
      'enabled',
      'stable',
      now,
      now,
    );

    const plugins = listPlugins(db, { skillsRoot });
    const overlap = plugins.find((p) => p.id === 'skill:overlap');
    expect(overlap?.name).toBe('数据库覆盖版');
    expect(overlap?.status).toBe('enabled');
    expect(overlap?.scope).toEqual({ level: 'workbench' });
  });

  it('dbOnly 跳过只读视图', () => {
    writeSkill(skillsRoot, 'only-skill', { name: 'only-skill', description: 'd' }, 'b');
    const plugins = listPlugins(db, { skillsRoot, dbOnly: true });
    expect(plugins.find((p) => p.id === 'skill:only-skill')).toBeUndefined();
    expect(plugins.find((p) => p.id === 'bridge:progress')).toBeUndefined();
  });

  it('getPlugin 先查数据库再查只读视图', () => {
    writeSkill(skillsRoot, 'lookup', { name: 'lookup', description: 'd' }, 'b');
    const fromView = getPlugin(db, 'skill:lookup', { skillsRoot });
    expect(fromView?.kind).toBe('skill');

    const fromDb = getPlugin(db, 'skill:nonexistent', { skillsRoot });
    expect(fromDb).toBeNull();
  });
});
