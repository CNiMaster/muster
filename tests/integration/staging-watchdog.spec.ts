/**
 * staging 合并看门狗（缺口感修复）：集成现场领先且无在办流程（活跃蜂群/验收任务）→ 自动 promote；
 * 冲突 → blocked 升级用户且同 HEAD 只提醒一次；在飞流程 → skipped 等既有钩子。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { createSwarmRun } from '../../src/server/domain/swarm';
import { sweepStaleStaging } from '../../src/server/domain/staging';
import { commitAll, ensureGitRepo, ensureStagingWorktree, stageStatus } from '../../src/server/worktree/manager';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

function fixture() {
  const company = restoreWorkbench(db, { id: 'wb_wd', name: 'co' });
  const lead = createAgent(db, { companyId: company.id, name: 'lead', role: 'lead' });
  const rootDir = makeTempGitRepo();
  const project = createProject(db, {
    companyId: company.id,
    name: 'p1',
    rootDir,
    firstAgentId: lead.id,
    initialState: 'active',
  });
  return { company, lead, project, rootDir };
}

/** 让 staging 领先主干 1 个提交。 */
function advanceStaging(rootDir: string, projectId: string, file: string, content: string): void {
  ensureGitRepo(rootDir);
  commitAll(rootDir, 'baseline');
  const staging = ensureStagingWorktree(rootDir, projectId);
  writeFileSync(path.join(staging.path, file), content);
  commitAll(staging.path, `staging: ${file}`);
}

function watchdogMessages(projectId: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS c FROM conversation_message WHERE scope_kind='project' AND scope_id=? AND content LIKE '[staging 看门狗]%'",
  ).get(projectId) as { c: number }).c;
}

describe('staging 合并看门狗', () => {
  it('领先且无在办流程 → 自动 promote 回主干并播报', () => {
    const { project, rootDir } = fixture();
    advanceStaging(rootDir, project.id, 'doc.md', '蜂群产物\n');
    expect(stageStatus(rootDir, project.id).aheadCommits).toBe(1);

    const result = sweepStaleStaging(db);
    expect(result.promoted).toBe(1);
    // 主干已包含 staging 提交
    expect(stageStatus(rootDir, project.id).aheadCommits).toBe(0);
    expect(watchdogMessages(project.id)).toBe(1);
    // 再扫：ahead=0 不再动作
    expect(sweepStaleStaging(db)).toEqual({ checked: 0, promoted: 0, blocked: 0 });
  });

  it('活跃蜂群在飞 → skipped 不动（等收口钩子）', () => {
    const { project, rootDir, lead } = fixture();
    advanceStaging(rootDir, project.id, 'doc.md', '蜂群产物\n');
    const root = createTask(db, { projectId: project.id, assigneeAgentId: lead.id, title: '蜂群根' });
    createSwarmRun(db, { projectId: project.id, rootTaskId: root.id, goal: 'g', requesterAgentId: lead.id });

    const result = sweepStaleStaging(db);
    expect(result.promoted).toBe(0);
    expect(result.blocked).toBe(0);
    expect(stageStatus(rootDir, project.id).aheadCommits).toBe(1);
    expect(watchdogMessages(project.id)).toBe(0);
  });

  it('合并冲突 → blocked 升级用户，同一 stagingHead 只提醒一次', () => {
    const { project, rootDir } = fixture();
    ensureGitRepo(rootDir);
    writeFileSync(path.join(rootDir, 'doc.md'), '基线\n');
    commitAll(rootDir, 'baseline');
    const staging = ensureStagingWorktree(rootDir, project.id);
    writeFileSync(path.join(staging.path, 'doc.md'), 'staging 改\n');
    commitAll(staging.path, 'staging edit');
    // 主干同文件不同改动 → promote 必冲突
    writeFileSync(path.join(rootDir, 'doc.md'), 'main 改\n');
    commitAll(rootDir, 'main edit');

    const first = sweepStaleStaging(db);
    expect(first.blocked).toBe(1);
    expect(stageStatus(rootDir, project.id).aheadCommits).toBe(1);
    expect(watchdogMessages(project.id)).toBe(1);

    // 同 HEAD 二次扫描：不重复尝试、不重复播报
    const second = sweepStaleStaging(db, { recheckMs: 0 });
    expect(second.blocked).toBe(0);
    expect(watchdogMessages(project.id)).toBe(1);
  });
});
