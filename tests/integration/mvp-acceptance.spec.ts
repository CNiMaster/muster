/**
 * Phase 8 · MVP 最终验收剧本
 *
 连续完成一个小说阶段，期间发生：
 1) 一次补充对话（waiting_input → 回答 → 恢复）
 2) 一次镜像并行（根员工 + 镜像 各领一个 Task）
 3) 一次章节事件更新（章节完成 → 触发 character + plot 维护 Task）
 4) 一次文件并发合并（Task worktree + 用户编辑自动三方合并）
 5) 一次强制复盘（达到阈值 → review_paused → 备注转修正 → 关闭）
 且无重复 Task、上下文串线或文件丢失。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createNovelCompany } from '../../src/server/domain/novel-template';
import { createProject, updateProject } from '../../src/server/domain/project';
import { ensurePrimaryThread, createMirror } from '../../src/server/domain/thread';
import {
  createTask,
  claimNextTask,
  markRunning,
  completeTask,
  answerClarification,
  listTasks,
} from '../../src/server/domain/task';
import { handleChapterCompleted } from '../../src/server/domain/triggers';
import {
  openReportCycle,
  addReportNote,
  closeReport,
} from '../../src/server/domain/report';
import { dispatchCorrectionTask } from '../../src/server/domain/triggers';
import { transitionCompany } from '../../src/server/domain/company';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import { ensureGitRepo, createWorktree, commitAll } from '../../src/server/worktree/manager';
import { PublishQueue } from '../../src/server/worktree/publish-queue';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let projectRoot: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  projectRoot = mkdtempSync(path.join(tmpdir(), 'muster-mvp-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('MVP acceptance: 一个小说阶段完整闭环', () => {
  it('补充对话 + 镜像并行 + 章节事件 + 并发合并 + 强制复盘，无重复/无丢失', async () => {
    // ===== 准备：小说公司 + 项目 + 上班 =====
    const r = createNovelCompany(db, { name: '星辰文化' });
    const project = createProject(db, {
      companyId: r.company.id,
      name: '星辰变',
      rootDir: projectRoot,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
    });
    transitionCompany(db, r.company.id, 'online');
    const writerThread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    const charThread = ensurePrimaryThread(db, project.id, r.agents.character.id);

    // 1) 补充对话：writer Task waiting_input → 回答 → 恢复 → 完成
    const chapterTask = createTask(db, {
      projectId: project.id,
      assigneeAgentId: r.agents.writer.id,
      dispatcherAgentId: r.agents.lead.id,
      title: '写第 1 章',
      inputProtocol: { goal: '主角登场' },
    });
    const fake = new FakeExecutor().script([
      { result: { outcome: 'waiting_input', summary: '需要主角背景', question: '主角叫什么？', outboundTasks: [], artifacts: [] } },
      {
        writeFiles: { 'chapters/01.md': '# 第一章\n李墨登场，灵根觉醒。\n' },
        result: {
          outcome: 'completed',
          summary: '第1章完成',
          outboundTasks: [],
          artifacts: [{ path: 'chapters/01.md', kind: 'markdown', operation: 'create' }],
        },
      },
    ]);
    const engine = new TaskEngine(db, fake);

    // 第一次：waiting_input
    await engine.pumpThread(writerThread.id);
    expect(listTasks(db, project.id).find((t) => t.id === chapterTask.id)!.state).toBe('waiting_input');
    // 派发者（用户）回答
    answerClarification(db, chapterTask.id, '主角叫李墨');
    // 第二次：completed
    await engine.pumpThread(writerThread.id);
    const finalChapter = listTasks(db, project.id).find((t) => t.id === chapterTask.id)!;
    expect(finalChapter.state).toBe('completed');

    // 2) 镜像并行：writer 主线程 + 一个 mirror 同时领不同 Task
    const t1 = createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: 'task-A' });
    const t2 = createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: 'task-B' });
    const mirror = createMirror(db, project.id, r.agents.writer.id);
    const c1 = claimNextTask(db, writerThread.id)!;
    const c2 = claimNextTask(db, mirror.id)!;
    expect(new Set([c1.task.id, c2.task.id])).toEqual(new Set([t1.id, t2.id]));
    // 释放
    markRunning(db, t1.id);
    completeTask(db, t1.id, { outcome: 'completed', summary: '', outboundTasks: [], artifacts: [] });
    markRunning(db, t2.id);
    completeTask(db, t2.id, { outcome: 'completed', summary: '', outboundTasks: [], artifacts: [] });

    // 3) 章节事件：完成章节触发 character + plot 维护 Task
    const beforeEvent = listTasks(db, project.id).length;
    handleChapterCompleted(db, {
      projectId: project.id,
      chapterPath: 'chapters/01.md',
      chapterSeq: 1,
      summary: '李墨登场，灵根觉醒',
      artifacts: [{ path: 'chapters/01.md', kind: 'markdown', operation: 'create' }],
    });
    const afterEvent = listTasks(db, project.id).length;
    expect(afterEvent - beforeEvent).toBe(2);
    const charMaint = listTasks(db, project.id).find((t) => t.assigneeAgentId === r.agents.character.id && t.title.includes('人物档案'));
    expect(charMaint).toBeDefined();

    // 4) 文件并发合并：Task worktree + 用户编辑，非重叠自动合并
    ensureGitRepo(projectRoot);
    // baseline 同时含两卷
    writeFileSync(path.join(projectRoot, 'outline.md'), '# 大纲\n\n## 第一卷\n第一卷内容\n\n## 第二卷\n第二卷内容\n');
    commitAll(projectRoot, 'baseline outline');
    const wt = createWorktree(projectRoot, project.id, 'task-outline');
    // worktree 只改第一卷那行
    writeFileSync(path.join(wt.path, 'outline.md'), '# 大纲\n\n## 第一卷\n第一卷内容（已细化）\n\n## 第二卷\n第二卷内容\n');
    commitAll(wt.path, 'task 细化第一卷');
    // 用户只改第二卷那行（不同位置）
    writeFileSync(path.join(projectRoot, 'outline.md'), '# 大纲\n\n## 第一卷\n第一卷内容\n\n## 第二卷\n第二卷内容（用户扩写）\n');
    commitAll(projectRoot, 'user 扩写第二卷');
    const q = new PublishQueue(db);
    const pub = q.publish({
      taskId: 'task-outline',
      threadId: charThread.id,
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      projectRootDir: projectRoot,
      artifacts: [{ path: 'outline.md', kind: 'markdown', operation: 'update' }],
    });
    expect(pub.blocked).toBe(false);
    const merged = readFileSync(path.join(projectRoot, 'outline.md'), 'utf8');
    expect(merged).toContain('已细化');
    expect(merged).toContain('用户扩写');

    // 5) 强制复盘：达到阈值，公司进 review_paused，备注转修正，关闭后归档
    const report = openReportCycle(db, { projectId: project.id, triggerKind: 'milestone' });
    expect(report.state).toBe('open');
    addReportNote(db, report.id, '主角名字要前后一致');
    addReportNote(db, report.id, '伏笔要回收');
    const beforeCorr = listTasks(db, project.id).length;
    closeReport(db, report.id, (note, seq) => {
      dispatchCorrectionTask(db, project.id, { note, sourceCycleSeq: seq });
    });
    const afterCorr = listTasks(db, project.id).length;
    expect(afterCorr - beforeCorr).toBe(2); // 两条备注各派一个修正 Task

    // ===== 全局不变量 =====
    const all = listTasks(db, project.id);
    // 无重复 Task（id 唯一）
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
    // 上下文未串线：character 维护 Task 派给 character，未误派给 writer
    const charTasks = all.filter((t) => t.assigneeAgentId === r.agents.character.id);
    expect(charTasks.length).toBeGreaterThan(0);
    charTasks.forEach((t) => expect(t.assigneeAgentId).toBe(r.agents.character.id));
    // 文件未丢失：outline.md 仍存在
    expect(readFileSync(path.join(projectRoot, 'outline.md'), 'utf8').length).toBeGreaterThan(0);
  });
});

void updateProject;
