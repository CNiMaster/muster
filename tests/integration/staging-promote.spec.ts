/**
 * staging promote 触发（A3）：
 * - 蜂群收口：根任务无验收标准 → maybePromoteSwarmStaging 自动 promote；有验收标准 → 不 promote（等验收）
 * - 验收 PASS：源任务属蜂群系 → handleAcceptanceReviewTaskCompleted 自动 promote + 播报
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTestDb, createNovelCompany } from './setup';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { ensureStagingWorktree } from '../../src/server/worktree/manager';
import { maybePromoteSwarmStaging } from '../../src/server/domain/swarm';
import { handleAcceptanceReviewTaskCompleted } from '../../src/server/domain/acceptance-review';
import { isSwarmLinkedTask } from '../../src/server/domain/staging';
import type { DB } from '../../src/server/db/client';

let root: string;
let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let projectId: string;
let leadId: string;
let companyId: string;

function git(dir: string, args: string[]): string {
  return execSync(`git ${args.map((a) => `'${a}'`).join(' ')}`, { cwd: dir, encoding: 'utf8' }).trim();
}

/** 在 staging 检出目录制造一次"蜂群已发布"的提交。 */
function seedStagingCommit(): void {
  const staging = ensureStagingWorktree(root, projectId);
  writeFileSync(path.join(staging.path, 'bee-output.txt'), 'bee output v1');
  git(staging.path, ['add', '-A']);
  git(staging.path, ['commit', '-m', 'staging: bee publish']);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'muster-stagprom-'));
  process.env.MUSTER_HOME = path.join(root, '.muster-home');
  tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  const project = createProject(db, { companyId: r.company.id, name: 'p', rootDir: root, firstAgentId: r.agents.lead.id, initialState: 'active' });
  projectId = project.id;
  leadId = r.agents.lead.id;
  companyId = r.company.id;
});

function seedSwarmRun(id: string): void {
  db.prepare(
    'INSERT INTO swarm_run (id, company_id, project_id, root_task_id, max_depth, max_width, max_nodes, budget_usd, created_at) VALUES (?,?,?,?,1,3,30,5,?)',
  ).run(id, companyId, projectId, '', new Date().toISOString());
}

afterEach(() => {
  tdb.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
});

describe('staging promote triggers (A3)', () => {
  it('蜂群收口无验收标准 → 自动 promote；有验收标准 → 不 promote', () => {
    seedStagingCommit();
    seedSwarmRun('sw_1');
    const rootTask = createTask(db, { projectId, title: '蜂群根任务', assigneeAgentId: leadId, swarmId: 'sw_1' });
    // 无验收 → promote
    maybePromoteSwarmStaging(db, rootTask.id);
    expect(readFileSync(path.join(root, 'bee-output.txt'), 'utf8')).toBe('bee output v1');
    // 主干已合并后，再次调用无内容可 promote（幂等 noop）
    maybePromoteSwarmStaging(db, rootTask.id);
    expect(readFileSync(path.join(root, 'bee-output.txt'), 'utf8')).toBe('bee output v1');
  });

  it('蜂群根任务带验收标准 → 收口不 promote（等验收 PASS）', () => {
    seedStagingCommit();
    seedSwarmRun('sw_2');
    const rootTask = createTask(db, {
      projectId, title: '带验收的蜂群根任务', assigneeAgentId: leadId,
      swarmId: 'sw_2',
      acceptanceCriteria: [{ id: 'ac_1', criterion: '产物完整', met: undefined }],
    });
    maybePromoteSwarmStaging(db, rootTask.id);
    // 主干没有 staging 内容
    const exists = (() => { try { readFileSync(path.join(root, 'bee-output.txt')); return true; } catch { return false; } })();
    expect(exists).toBe(false);
  });

  it('验收 PASS（源任务属蜂群系）→ 自动 promote', () => {
    seedStagingCommit();
    seedSwarmRun('sw_3');
    const source = createTask(db, {
      projectId, title: '蜂群产出任务', assigneeAgentId: leadId, swarmId: 'sw_3',
      acceptanceCriteria: [{ id: 'ac_1', criterion: '产出完整', met: undefined }],
    });
    db.prepare("UPDATE task SET state='completed', summary='蜂群交付完成' WHERE id=?").run(source.id);
    const reviewTask = createTask(db, {
      projectId, title: '[验收] 蜂群产出任务', assigneeAgentId: leadId,
      inputProtocol: {
        acceptanceReview: {
          sourceTaskId: source.id, sourceSwarmId: 'sw_3',
          criteria: source.acceptanceCriteria,
          artifacts: [], summary: '蜂群交付完成',
        },
        instruction: 'VERDICT=PASS|FAIL|CHANGES',
      },
    });
    db.prepare("UPDATE task SET state='completed', summary='VERDICT=PASS\nCONFIDENCE=0.95\n合格' WHERE id=?").run(reviewTask.id);
    const completed = db.prepare('SELECT * FROM task WHERE id=?').get(reviewTask.id) as any;
    handleAcceptanceReviewTaskCompleted(db, { ...completed, inputProtocol: JSON.parse(completed.input_protocol_json ?? '{}') } as any);
    // 验收通过 → promote 已执行，主干可见
    expect(readFileSync(path.join(root, 'bee-output.txt'), 'utf8')).toBe('bee output v1');
  });

  it('review C1：返工任务带 sourceSwarmId 标记——isSwarmLinkedTask 四源谓词全命中', () => {
    seedStagingCommit();
    seedSwarmRun('sw_4');
    const source = createTask(db, {
      projectId, title: '蜂群产出任务', assigneeAgentId: leadId, swarmId: 'sw_4',
      acceptanceCriteria: [{ id: 'ac_1', criterion: '产出完整', met: undefined }],
    });
    db.prepare("UPDATE task SET state='completed', summary='交付' WHERE id=?").run(source.id);
    const reviewTask = createTask(db, {
      projectId, title: '[验收] 蜂群产出任务', assigneeAgentId: leadId,
      inputProtocol: {
        acceptanceReview: { sourceTaskId: source.id, sourceSwarmId: 'sw_4', criteria: source.acceptanceCriteria, artifacts: [], summary: '' },
        instruction: 'VERDICT=PASS|FAIL|CHANGES',
      },
    });
    db.prepare("UPDATE task SET state='completed', summary='VERDICT=FAIL\nCONFIDENCE=0.9\n不合格' WHERE id=?").run(reviewTask.id);
    const completed = db.prepare('SELECT * FROM task WHERE id=?').get(reviewTask.id) as any;
    handleAcceptanceReviewTaskCompleted(db, { ...completed, inputProtocol: JSON.parse(completed.input_protocol_json ?? '{}') } as any);
    // 返工任务被派出且带 sourceSwarmId → swarmLinked（基线与发布目标都会指向 staging）
    const rework = db.prepare("SELECT * FROM task WHERE title LIKE '[返工]%' ORDER BY id DESC LIMIT 1").get() as any;
    expect(rework).toBeTruthy();
    const reworkTask = { swarmId: rework.swarm_id, inputProtocol: JSON.parse(rework.input_protocol_json ?? '{}') };
    expect(isSwarmLinkedTask(reworkTask)).toBe(true);
    // 四源谓词：stagingProjectId（裁决任务标记）/ acceptanceReview.sourceSwarmId / 无标记 = false
    expect(isSwarmLinkedTask({ swarmId: null, inputProtocol: { stagingProjectId: projectId } })).toBe(true);
    expect(isSwarmLinkedTask({ swarmId: null, inputProtocol: { acceptanceReview: { sourceSwarmId: 'sw_x' } } })).toBe(true);
    expect(isSwarmLinkedTask({ swarmId: null, inputProtocol: { trigger: 'user_message' } })).toBe(false);
  });
});
