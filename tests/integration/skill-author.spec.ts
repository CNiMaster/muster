/**
 * B3b AI 起草测试：mock callLlm，验证起草 → 落盘 → 注册流程。
 * 不实际调用 LLM（避免依赖网络/凭据）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { authorSkill } from '../../src/server/domain/skill-author';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let skillsRoot: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  skillsRoot = mkdtempSync(join(tmpdir(), 'muster-author-'));
});

afterEach(() => {
  tdb.close();
  vi.restoreAllMocks();
  try {
    rmSync(skillsRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('authorSkill', () => {
  it('mock LLM 返回合法 SKILL.md → 落盘 + 注册', async () => {
    const mockContent = `---\nname: web-research\ndescription: Use when you need to research the web.\n---\n# Web Research\n步骤...`;
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue({
      content: mockContent,
      model: 'mock',
      usage: { promptTokens: 10, completionTokens: 20 },
    });

    const plugin = await authorSkill(db, {
      capability: '需要网页调研能力',
      context: '项目调研阶段',
      skillsRoot,
    });

    expect(plugin.kind).toBe('skill');
    expect(plugin.source.kind).toBe('ai-generated');
    expect(plugin.maturity).toBe('experimental');
    expect(plugin.name).toBe('web-research');
    // 落盘验证
    const skillFile = join(skillsRoot, 'web-research', 'SKILL.md');
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, 'utf8')).toBe(mockContent);
  });

  it('LLM 返回无 frontmatter 时用自动 id', async () => {
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue({
      content: '没有 frontmatter 的内容',
      model: 'mock',
      usage: { promptTokens: 5, completionTokens: 5 },
    });

    const plugin = await authorSkill(db, { capability: '测试能力', skillsRoot });
    expect(plugin.name).toMatch(/^ai-sk/);
    expect(plugin.source.kind).toBe('ai-generated');
  });

  it('LLM 失败时抛错（不落盘不注册）', async () => {
    vi.spyOn(llmCallModule, 'callLlm').mockRejectedValue(new Error('LLM 调用失败'));
    await expect(authorSkill(db, { capability: 'x', skillsRoot })).rejects.toThrow('LLM 调用失败');
  });
});
