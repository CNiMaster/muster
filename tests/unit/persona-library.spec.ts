/**
 * Persona 提示词库（阶段三任务 3.1）单元测试。
 *
 * 验证：
 * 1. parsePersonaFile：frontmatter + 正文 → soul/principles/capabilities
 * 2. listPersonas / listPersonaDomains / getPersona / searchPersonas
 * 3. POST /api/agent-profiles 带 personaId 自动填充
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../integration/setup';
import { setDbForTest } from '../../src/server/db/client';
import { createAgentProfile, getAgentProfile } from '../../src/server/domain/agent-profile';
import { parsePersonaFile, listPersonas, listPersonaDomains, getPersona, searchPersonas } from '../../src/server/domain/persona-library';
import { getPersona as getPersonaApi } from '../../src/server/domain/persona-library';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

const SAMPLE_PERSONA = `---
name: 内容创作者
description: 擅长多平台内容策划与创作的内容专家
emoji: ✍️
color: "#FF7F50"
---

# 内容创作者

你是**内容创作者**，一位实战派创作者。

## 你的身份与记忆

- **角色**：内容策略师与多平台创作者
- **经验**：公众号、知乎、小红书实战经验

## 核心使命

### 内容策略

- 内容矩阵规划
- 选题策划

### 多平台创作

- 长文深度内容
- 短内容：小红书、Twitter

## 关键规则

- 标题决定 80% 的命运
- 每篇内容必须有一个明确的 CTA
- 不写自嗨内容

## 技术交付物

- 内容矩阵方案
- 爆款标题库
- 发布排期表
`;

describe('parsePersonaFile', () => {
  it('解析 frontmatter + 正文为 soul/principles/capabilities', () => {
    const persona = parsePersonaFile('marketing/marketing-content-creator', 'marketing', SAMPLE_PERSONA);
    expect(persona).not.toBeNull();
    expect(persona!.id).toBe('marketing/marketing-content-creator');
    expect(persona!.domain).toBe('marketing');
    expect(persona!.name).toBe('内容创作者');
    expect(persona!.emoji).toBe('✍️');
    // soul 包含身份与使命段落
    expect(persona!.soul).toContain('内容策略师');
    expect(persona!.soul).toContain('内容矩阵规划');
    // principles 来自关键规则列表项
    expect(persona!.principles).toContain('标题决定 80% 的命运');
    expect(persona!.principles).toContain('每篇内容必须有一个明确的 CTA');
    expect(persona!.principles.length).toBeLessThanOrEqual(8);
    // capabilities 来自技术交付物
    const skills = (persona!.capabilities.skills as string[]) ?? [];
    expect(skills).toContain('内容矩阵方案');
    expect(skills).toContain('爆款标题库');
  });

  it('无 frontmatter name 的文件返回 null', () => {
    expect(parsePersonaFile('x', null, '# 无元数据')).toBeNull();
  });
});

describe('persona 库查询', () => {
  it('listPersonas 返回全部并支持 domain 过滤', () => {
    const all = listPersonas();
    expect(all.length).toBeGreaterThan(100); // 211 个
    const marketing = listPersonas('marketing');
    expect(marketing.length).toBeGreaterThan(30);
    expect(marketing.every((p) => p.domain === 'marketing')).toBe(true);
  });

  it('listPersonaDomains 返回域统计', () => {
    const domains = listPersonaDomains();
    expect(domains.length).toBeGreaterThan(5);
    const marketing = domains.find((d) => d.domain === 'marketing');
    expect(marketing?.count).toBeGreaterThan(30);
  });

  it('getPersona 与 searchPersonas', () => {
    const p = getPersona('marketing/marketing-content-creator');
    expect(p?.name).toBeTruthy();
    expect(getPersona('not-exist')).toBeNull();
    const hits = searchPersonas('内容创作者');
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('personaId 自动填充 AgentProfile', () => {
  it('带 personaId 创建档案时自动填充 soul/principles/capabilities', () => {
    const persona = getPersonaApi('marketing/marketing-content-creator');
    expect(persona).not.toBeNull();
    const profile = createAgentProfile(db, {
      displayName: persona!.name,
      personaId: persona!.id,
    });
    const saved = getAgentProfile(db, profile.id);
    expect(saved.soul).toBe(persona!.soul);
    expect(saved.principles).toEqual(persona!.principles);
    expect(saved.capabilities.personaId).toBe(persona!.id);
  });

  it('用户显式字段覆盖 persona 自动填充', () => {
    const persona = getPersonaApi('marketing/marketing-content-creator');
    const customSoul = '我是自定义人格';
    const profile = createAgentProfile(db, {
      displayName: '自定义内容专家',
      personaId: persona!.id,
      soul: customSoul,
    });
    const saved = getAgentProfile(db, profile.id);
    expect(saved.soul).toBe(customSoul);
    expect(saved.principles).toEqual(persona!.principles);
  });
});
