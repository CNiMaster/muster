/**
 * 批次 E1（专家知识库工程）单元测试：
 * 1. canonicalHeading 标题归一（emoji/衬词/变体表）
 * 2. parsePersonaFile 变体标题存活 + sections 全量目录
 * 3. 全库普查：预置人设全可解析、灵魂节存活、nexus-strategy 补 frontmatter 后可见
 * 4. extractPreservableSections：updateUserPersona 重写前的知识节保全
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalHeading,
  parsePersonaFile,
  listPersonas,
  getPersona,
  personaManualPath,
  extractPreservableSections,
} from '../../src/server/domain/persona-library';

describe('canonicalHeading 标题归一', () => {
  it('剥 emoji/标点前缀与衬词，变体并轨正典', () => {
    expect(canonicalHeading('你的身份与记忆')).toBe('你的身份与记忆');
    expect(canonicalHeading('🧠 身份与记忆')).toBe('你的身份与记忆');
    expect(canonicalHeading('身份与角色')).toBe('你的身份与记忆');
    expect(canonicalHeading('你的核心使命')).toBe('核心使命');
    expect(canonicalHeading('核心使命与能力')).toBe('核心使命');
    expect(canonicalHeading('🚨 关键规则')).toBe('关键规则');
    expect(canonicalHeading('必须遵守的规则')).toBe('关键规则');
    expect(canonicalHeading('你必须遵守的关键规则')).toBe('关键规则');
    expect(canonicalHeading('你必须遵循的关键规则')).toBe('关键规则');
    expect(canonicalHeading('🛠️ 你的技术交付物')).toBe('技术交付物');
    expect(canonicalHeading('你的工作流程')).toBe('工作流程');
    expect(canonicalHeading('你的成功指标')).toBe('成功指标');
  });

  it('未知知识节标题原样保留（不做过度归一）', () => {
    expect(canonicalHeading('学习与记忆')).toBe('学习与记忆');
    expect(canonicalHeading('领域专业知识')).toBe('领域专业知识');
    expect(canonicalHeading('交付物模板')).toBe('交付物模板');
    expect(canonicalHeading('第 3 阶段构建与迭代')).toBe('第 3 阶段构建与迭代');
  });
});

const VARIANT_PERSONA = `---
name: 变体专家
description: 用变体标题书写的专家
---

# 变体专家

## 🧠 身份与记忆

- **角色**：全栈工程师

## 你的核心使命

交付端到端功能

## 必须遵守的规则

- 先读后写
- 小步提交

## 🛠️ 你的技术交付物

- 功能代码

## 领域专业知识

React 19 的 use() 与 useOptimistic 是本领域新默认……
`;

describe('parsePersonaFile 变体标题与节目录', () => {
  it('变体标题下 soul/principles/capabilities 全存活', () => {
    const p = parsePersonaFile('dev/variant', 'dev', VARIANT_PERSONA);
    expect(p).not.toBeNull();
    expect(p!.soul).toContain('全栈工程师');
    expect(p!.soul).toContain('交付端到端功能');
    expect(p!.principles).toContain('先读后写');
    expect(p!.capabilities.skills as string[]).toContain('功能代码');
  });

  it('sections 目录全量（归一序）且知识节带字数', () => {
    const p = parsePersonaFile('dev/variant', 'dev', VARIANT_PERSONA)!;
    expect(p.sections.map((s) => s.title)).toEqual([
      '你的身份与记忆',
      '核心使命',
      '关键规则',
      '技术交付物',
      '领域专业知识',
    ]);
    const knowledge = p.sections.find((s) => s.title === '领域专业知识')!;
    expect(knowledge.chars).toBeGreaterThan(0);
  });
});

describe('全库普查（批次 E1 门）', () => {
  it('全部预置人设可解析且带 sections/filePath', () => {
    const builtin = listPersonas().filter((p) => p.source === 'builtin');
    expect(builtin.length).toBeGreaterThanOrEqual(238);
    for (const p of builtin) {
      expect(p.name.length, p.id).toBeGreaterThan(0);
      expect(Array.isArray(p.sections), p.id).toBe(true);
      expect(p.filePath.endsWith('.md'), p.id).toBe(true);
    }
  });

  it('灵魂节存活：变体归一后 description 兜底只剩本身无身份/使命节的文件', () => {
    const builtin = listPersonas().filter((p) => p.source === 'builtin');
    const fallen = builtin.filter((p) => p.soul === p.description || p.soul === p.name);
    // 修复前 56 个变体文件解析近零存活；归一后仅剩 7 个本身就没有身份/使命节的文件
    expect(fallen.length, fallen.map((p) => p.id).join(',')).toBeLessThanOrEqual(7);
  });

  it('nexus-strategy 补 frontmatter 后可见且节目录完整', () => {
    const p = getPersona('product/nexus-strategy');
    expect(p).not.toBeNull();
    expect(p!.name).toBe('NEXUS 策略运营专家');
    expect(p!.sections.length).toBeGreaterThanOrEqual(20);
    expect(personaManualPath(p!)).toContain('personas/product/nexus-strategy.md');
  });
});

describe('extractPreservableSections 知识节保全', () => {
  const RAW = `---
name: 某专家
description: x
---

# 某专家

## 你的身份与记忆

身份内容

## 关键规则

- 规则一

## 领域专业知识

领域门道正文

## 🧠 身份与记忆

变体身份（受保护，应被剔除）

## 学习与记忆

经验条目
`;

  it('非身份三节原样保全（含变体受保护节剔除）', () => {
    const kept = extractPreservableSections(RAW);
    expect(kept.map((s) => s.split('\n')[0])).toEqual(['## 领域专业知识', '## 学习与记忆']);
    expect(kept[0]).toContain('领域门道正文');
    expect(kept[1]).toContain('经验条目');
  });

  it('空输入安全', () => {
    expect(extractPreservableSections('')).toEqual([]);
    expect(extractPreservableSections('# 只有标题')).toEqual([]);
  });
});
