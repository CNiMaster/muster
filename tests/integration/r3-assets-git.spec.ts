/**
 * R3：资产库升级 + git 正确性 集成测试。
 *
 * 验证：
 * - statArtifactProps：size/mime 元数据。
 * - upsertPublishedArtifact 登记时记录 props（排序/预览依据）。
 * - deleteArtifact：文件删除 + 登记移除 + git 提交删除（历史可回滚）+ 审计。
 * - buildRevealCommand：darwin/win32/linux 平台命令拼装。
 * - writeArtifactContent 保存即产生独立 git 提交（不再卷进 agent 发布提交）。
 * - assembleContext 含「# 工作区与发布」教学段（轻量模式不含）。
 */
import { beforeEach, describe, expect, it, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { makeTestDb, makeTempGitRepo } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { assembleContext } from '../../src/server/executors/context';
import {
  upsertPublishedArtifact,
  deleteArtifact,
  getArtifactByPath,
  statArtifactProps,
  buildRevealCommand,
  registerArtifact,
} from '../../src/server/domain/artifact';
import { writeArtifactContent } from '../../src/server/domain/artifact-content';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
beforeEach(() => { tdb = makeTestDb(); db = tdb.db; });
afterEach(() => tdb.close());

function seedWithRepo() {
  const rootDir = makeTempGitRepo();
  const c = createCompany(db, { name: '公司' });
  const agent = createAgent(db, { companyId: c.id, name: '干员', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir, firstAgentId: agent.id, initialState: 'active',
  });
  return { c, agent, p, rootDir };
}

function gitLog(rootDir: string): string {
  return execSync('git -C ' + JSON.stringify(rootDir) + ' log --format=%s', { encoding: 'utf8' });
}

describe('资产元数据（R3）', () => {
  it('statArtifactProps：size/mime 按扩展名', () => {
    const { rootDir } = seedWithRepo();
    const abs = path.join(rootDir, '报告.md');
    writeFileSync(abs, 'hello world');
    const props = statArtifactProps(abs);
    expect(props.size).toBe(11);
    expect(props.mime).toBe('text/markdown');
    const pptx = path.join(rootDir, '演示.pptx');
    writeFileSync(pptx, '');
    expect(statArtifactProps(pptx).mime).toContain('presentationml');
  });

  it('upsertPublishedArtifact 登记时记录 props', () => {
    const { agent, p, rootDir } = seedWithRepo();
    const task = createTask(db, { projectId: p.id, assigneeAgentId: agent.id, title: '产出任务' });
    writeFileSync(path.join(rootDir, '成果.md'), '内容内容');
    const art = upsertPublishedArtifact(db, {
      projectId: p.id, path: '成果.md', kind: 'markdown', ownerAgentId: agent.id, taskId: task.id,
    });
    expect(art.createdTaskId).toBe(task.id);
    expect((art.props as { size: number }).size).toBeGreaterThan(0);
    expect((art.props as { mime: string }).mime).toBe('text/markdown');
  });
});

describe('资产库删除（R3）', () => {
  it('deleteArtifact：文件删除 + 登记移除 + git 提交删除', () => {
    const { agent, p, rootDir } = seedWithRepo();
    const task = createTask(db, { projectId: p.id, assigneeAgentId: agent.id, title: '任务' });
    const rel = 'reports/删除我.md';
    // 走用户编辑路径创建（writeArtifactContent 会产生独立提交，文件在 git 中有历史）
    registerArtifact(db, { projectId: p.id, path: rel, kind: 'markdown' });
    writeArtifactContent(db, p.id, rel, '待删除内容');
    expect(getArtifactByPath(db, p.id, rel)).not.toBeNull();

    deleteArtifact(db, p.id, rel, 'user');

    expect(getArtifactByPath(db, p.id, rel)).toBeNull();
    expect(existsSync(path.join(rootDir, rel))).toBe(false);
    // git 历史保留删除提交（可回滚）
    expect(gitLog(rootDir)).toContain('muster: delete artifact');
    // 审计留痕
    const audit = db.prepare(
      "SELECT action FROM artifact_change_log WHERE artifact_path=? AND action='delete'",
    ).get(rel) as { action: string } | undefined;
    expect(audit?.action).toBe('delete');
    void agent; void task;
  });

  it('未登记路径删除报错', () => {
    const { p } = seedWithRepo();
    expect(() => deleteArtifact(db, p.id, '不存在.md', 'user')).toThrow(/未登记/);
  });
});

describe('资源管理器定位命令（R3）', () => {
  it('darwin → open -R（Finder 定位）', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const { command, args } = buildRevealCommand('/tmp/a/b.png');
      expect(command).toBe('open');
      expect(args).toEqual(['-R', '/tmp/a/b.png']);
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it('linux → xdg-open 打开所在目录', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const { command, args } = buildRevealCommand('/tmp/a/b.png');
      expect(command).toBe('xdg-open');
      expect(args).toEqual(['/tmp/a']);
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });
});

describe('用户编辑即提交（R3 git 正确性）', () => {
  it('writeArtifactContent 保存后产生独立 git 提交', () => {
    const { p, rootDir } = seedWithRepo();
    const rel = 'docs/用户笔记.md';
    mkdirSync(path.dirname(path.join(rootDir, rel)), { recursive: true });
    registerArtifact(db, { projectId: p.id, path: rel, kind: 'markdown' });
    writeArtifactContent(db, p.id, rel, '用户改的内容');
    expect(gitLog(rootDir)).toContain('muster: user edit');
  });
});

describe('worktree 教学段（R3）', () => {
  it('非轻量上下文含「# 工作区与发布」', () => {
    const { agent, p } = seedWithRepo();
    const task = createTask(db, { projectId: p.id, assigneeAgentId: agent.id, title: '任务' });
    const sp = assembleContext(db, task).systemPrompt;
    expect(sp).toContain('# 工作区与发布');
    expect(sp).toContain('不要自行 git merge');
  });

  it('轻量模式不含教学段（咨询/发言精简上下文）', () => {
    const { agent, p } = seedWithRepo();
    const task = createTask(db, {
      projectId: p.id, assigneeAgentId: agent.id, title: '咨询',
      inputProtocol: { consultation: true, question: '问一下' },
    });
    const sp = assembleContext(db, task, { lightweight: true }).systemPrompt;
    expect(sp).not.toContain('# 工作区与发布');
  });
});
