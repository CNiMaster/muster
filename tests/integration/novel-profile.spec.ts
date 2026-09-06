/**
 * 2026-09-06 收尾批次：打法档案建档状态 / 伏笔半衰期诊断 / 存量项目成果补种。
 * 对应 spec：docs/superpowers/specs/2026-09-06-blueprint-domain-profile.md 的三个收尾口子。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestDb } from './setup';
import { createNovelCompany } from './setup';
import type { DB } from '../../src/server/db/client';
import { createProject } from '../../src/server/domain/project';
import { transitionWorkbench } from '../../src/server/domain/workbench';
import {
  initializeNovelProject,
  ensureNovelProjectArtifacts,
  getNovelProfileStatus,
  detectStaleHooks,
  GENRE_RULES_PATH,
} from '../../src/server/domain/novel-template';
import { writeArtifactContent } from '../../src/server/domain/artifact-content';
import { listArtifacts } from '../../src/server/domain/artifact';
import { readFileSync } from 'node:fs';
import { handleChapterCompleted } from '../../src/server/domain/triggers';
import { getTask } from '../../src/server/domain/task';

let db: DB;
let tmpRoots: string[] = [];

beforeEach(() => {
  db = makeTestDb().db;
});

afterEach(() => {
  for (const root of tmpRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpRoots = [];
});

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'muster-novel-profile-'));
  tmpRoots.push(root);
  return root;
}

function setupProject(name: string, { initialize = true } = {}): { projectId: string; rootDir: string } {
  const r = createNovelCompany(db, { name });
  transitionWorkbench(db, 'online');
  const rootDir = makeTmpRoot();
  const project = createProject(db, {
    companyId: r.company.id,
    name: 'p',
    rootDir,
    firstAgentId: r.agents.lead.id,
  });
  if (initialize) initializeNovelProject(db, project.id);
  return { projectId: project.id, rootDir };
}

describe('打法档案建档状态（getNovelProfileStatus）', () => {
  it('新建项目：档案存在，六栏位全部待确认', () => {
    const { projectId } = setupProject('状态公司');
    const status = getNovelProfileStatus(db, projectId);
    expect(status.exists).toBe(true);
    expect(status.totalSlots).toBe(6);
    expect(status.pendingSlots).toBe(6);
    expect(status.pendingTitles).toContain('章节类型');
  });

  it('逐栏确认：改掉「待定」字样即计为已确认', () => {
    const { projectId, rootDir } = setupProject('确认公司');
    const path = GENRE_RULES_PATH;
    writeArtifactContent(db, projectId, path, [
      '# 打法档案',
      '',
      '## 章节类型',
      '',
      '冲突章/铺垫章/过渡章/回收章——本书自定义。',
      '',
      '## 节奏承诺',
      '',
      '三章内一次小反馈。（待定）',
      '',
    ].join('\n'));
    const status = getNovelProfileStatus(db, projectId);
    expect(status.pendingSlots).toBe(5);
    expect(status.pendingTitles).not.toContain('章节类型');
    expect(existsSync(join(rootDir, path))).toBe(true);
  });

  it('档案成果缺失（ensure 前的存量项目）：exists=false 且全部待确认', () => {
    const { projectId } = setupProject('缺口公司', { initialize: false });
    const status = getNovelProfileStatus(db, projectId);
    expect(status.exists).toBe(false);
    expect(status.pendingSlots).toBe(6);
  });
});

describe('伏笔半衰期诊断（detectStaleHooks）', () => {
  it('只标「已过预期回收且未回收/未弃收」的行', () => {
    const { projectId } = setupProject('半衰期公司');
    writeArtifactContent(db, projectId, 'canon/foreshadowing.md', [
      '# 伏笔账本',
      '',
      '| 编号 | 埋设章 | 类型 | 状态 | 最近推进 | 预期回收 | 依赖 | 备注 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      '| F001 | 1 | 悬念 | 埋设 | 3 | 10 | — | 主线 |',
      '| F002 | 2 | 承诺 | 已回收 | 9 | 9 | — | 兑现 |',
      '| F003 | 2 | 铺垫 | 推进中 | 6 | 15 | F001 | 后置 |',
      '| F004 | 1 | 误导 | 弃收 | 4 | 5 | — | 删线 |',
      '| F005 | 1 | 悬念 | 埋设 | 3 | 未定 | — | 没写预期 |',
      '',
    ].join('\n'));
    const stale = detectStaleHooks(db, projectId, 12);
    expect(stale.map((h) => h.id)).toEqual(['F001']);
    expect(stale[0]!.expectedPayoff).toBe('10');
  });

  it('账本不存在或全在期限内：返回空', () => {
    const { projectId } = setupProject('干净公司');
    expect(detectStaleHooks(db, projectId, 12)).toEqual([]);
  });
});

describe('存量项目成果补种（ensureNovelProjectArtifacts）', () => {
  it('补回缺失的 genre-rules 成果，不覆盖已有账本内容', () => {
    const { projectId, rootDir } = setupProject('补种公司');
    // 模拟旧版初始化的存量项目：伏笔账本已是用户内容；genre_rules 行与文件均不存在
    writeArtifactContent(db, projectId, 'canon/foreshadowing.md', '# 伏笔资料\n\n旧版自由文本，用户已写过内容。\n');
    db.prepare("DELETE FROM artifact WHERE project_id=? AND kind='genre_rules'").run(projectId);
    rmSync(join(rootDir, GENRE_RULES_PATH), { force: true });

    const ensured = ensureNovelProjectArtifacts(db);
    expect(ensured).toBeGreaterThanOrEqual(1);

    const kinds = listArtifacts(db, projectId).map((a) => a.kind);
    expect(kinds).toContain('genre_rules');
    const restored = readFileSync(join(rootDir, GENRE_RULES_PATH), 'utf8');
    expect(restored).toContain('打法档案');
    expect(readFileSync(join(rootDir, 'canon/foreshadowing.md'), 'utf8')).toContain('旧版自由文本');
  });

  it('非小说工作台静默跳过', () => {
    // 默认 makeTestDb 工作台非 novel kind：不初始化、不补种
    const { projectId } = setupProject('普通公司');
    db.prepare("DELETE FROM artifact WHERE project_id=? AND kind='genre_rules'").run(projectId);
    rmSync(join(tmpRoots[tmpRoots.length - 1]!, GENRE_RULES_PATH), { force: true });
    // 覆盖工作台 kind 为默认（非 novel）
    db.prepare("UPDATE workbench SET kind='general'").run();
    expect(ensureNovelProjectArtifacts(db)).toBe(0);
  });
});

describe('半衰期诊断进维护载荷（handleChapterCompleted）', () => {
  it('章节完成时 plot 维护 Task 携带 staleHooks', () => {
    const { projectId } = setupProject('载荷公司');
    writeArtifactContent(db, projectId, 'canon/foreshadowing.md', [
      '# 伏笔账本',
      '',
      '| 编号 | 埋设章 | 类型 | 状态 | 最近推进 | 预期回收 | 依赖 | 备注 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      '| F001 | 1 | 悬念 | 埋设 | 3 | 5 | — | 已超期 |',
      '',
    ].join('\n'));
    const dispatched = handleChapterCompleted(db, {
      projectId,
      chapterPath: 'chapters/12.md',
      chapterSeq: 12,
      summary: '完成第十二章',
      artifacts: [{ path: 'chapters/12.md', kind: 'chapter', operation: 'create' }],
    });
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    const tasks = dispatched.map((id) => getTask(db, id));
    const plotTask = tasks.find((t) => t.title.includes('维护剧情进度与伏笔'));
    expect(plotTask).toBeDefined();
    const staleHooks = (plotTask!.inputProtocol as Record<string, unknown>).staleHooks as Array<{ id: string }>;
    expect(staleHooks).toEqual([{ id: 'F001', startChapter: '1', status: '埋设', lastAdvanced: '3', expectedPayoff: '5', notes: '已超期' }]);
  });
});
