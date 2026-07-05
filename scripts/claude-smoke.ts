import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDb, getDb } from '../src/server/db/client';
import { createNovelCompany } from '../src/server/domain/novel-template';
import { createProject } from '../src/server/domain/project';
import { clockIn } from '../src/server/domain/company';
import { createTask, getTask } from '../src/server/domain/task';
import { ensurePrimaryThread, getThread } from '../src/server/domain/thread';
import { ensureGitRepo, commitAll } from '../src/server/worktree/manager';
import { ClaudeCodeAdapter } from '../src/server/executors/claude-code-adapter';
import { TaskEngine } from '../src/server/task-engine/engine';
import { listArtifacts } from '../src/server/domain/artifact';
import { summarizeProjectUsage } from '../src/server/domain/usage';

const rootDir = mkdtempSync(path.join(tmpdir(), 'muster-claude-smoke-project-'));

try {
  const db = getDb();
  const novel = createNovelCompany(db, { name: 'Claude 冒烟公司' });
  const project = createProject(db, {
    companyId: novel.company.id,
    name: 'Claude 冒烟项目',
    rootDir,
    firstAgentId: novel.agents.lead.id,
  });
  ensureGitRepo(rootDir);
  writeFileSync(path.join(rootDir, 'README.md'), '# Claude smoke\n');
  commitAll(rootDir, 'smoke baseline');
  const thread = ensurePrimaryThread(db, project.id, novel.agents.writer.id);
  clockIn(db, novel.company.id);

  const first = createTask(db, {
    projectId: project.id,
    assigneeAgentId: novel.agents.writer.id,
    title: '创建真实执行器冒烟文件',
    inputProtocol: {
      goal: '在项目根目录创建 smoke.md，内容包含“首次真实执行成功”。完成后声明该文件为 markdown create artifact。',
    },
    outputProtocol: { requiredArtifact: 'smoke.md' },
  });
  const engine = new TaskEngine(db, new ClaudeCodeAdapter({
    model: process.env.MUSTER_MODEL,
    timeoutMs: 120_000,
  }));
  await engine.pumpThread(thread.id);
  if (getTask(db, first.id).state !== 'completed') {
    throw new Error(`首次 Task 未完成：${getTask(db, first.id).summary}`);
  }
  const firstSession = getThread(db, thread.id).claudeSessionId;
  if (!firstSession) throw new Error('首次执行未保存 Claude session id');

  const second = createTask(db, {
    projectId: project.id,
    assigneeAgentId: novel.agents.writer.id,
    title: '续接会话更新冒烟文件',
    inputProtocol: {
      goal: '读取 smoke.md，在末尾增加“续接会话成功”。完成后声明该文件为 markdown update artifact。',
    },
    contextRefs: ['smoke.md'],
    outputProtocol: { requiredArtifact: 'smoke.md' },
  });
  await engine.pumpThread(thread.id);
  if (getTask(db, second.id).state !== 'completed') {
    throw new Error(`续接 Task 未完成：${getTask(db, second.id).summary}`);
  }
  if (getThread(db, thread.id).claudeSessionId !== firstSession) {
    throw new Error('续接执行没有复用原 Claude session');
  }
  if (!existsSync(path.join(rootDir, 'smoke.md'))) throw new Error('smoke.md 未发布');
  const content = readFileSync(path.join(rootDir, 'smoke.md'), 'utf8');
  if (!content.includes('首次真实执行成功') || !content.includes('续接会话成功')) {
    throw new Error(`smoke.md 内容不完整：${content}`);
  }
  if (!listArtifacts(db, project.id).some((artifact) => artifact.path === 'smoke.md')) {
    throw new Error('Artifact 未登记');
  }
  const usage = summarizeProjectUsage(db, project.id);
  if (usage.totalInputTokens <= 0 || usage.totalOutputTokens <= 0) {
    throw new Error('真实用量未记录');
  }
  console.log(JSON.stringify({
    ok: true,
    sessionId: firstSession,
    tasks: [first.id, second.id],
    artifact: 'smoke.md',
    inputTokens: usage.totalInputTokens,
    outputTokens: usage.totalOutputTokens,
    cacheReadTokens: usage.totalCacheReadTokens,
  }));
} finally {
  closeDb();
  rmSync(rootDir, { recursive: true, force: true });
}
