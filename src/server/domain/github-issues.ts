/**
 * GitHub Issues 自动化执行链（整改计划 Part2 批次 6）。
 *
 * 到点 → gh 拉取开放 issues → 幂等记账（repo+number 只派发一次）→ 新 issue 建「[Issue]」任务
 * 派给**绑定负责人**（用户定案：自动化工作由负责人按时领取；负责人分诊——真 bug/功能/
 * 疑问/无法复现自由分类，先验证复现再开工）→ 修复子任务产物落任务级集成区，**等用户审批 promote，
 * 绝不自动合并**（用户明令）。
 */
import { spawn } from 'node:child_process';
import type { DB } from '../db/client';
import { log } from '../logger';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getProject } from './project';
import { peekRepoRoot } from './task-repo';
import { createTask } from './task';
import { ensurePrimaryThread } from './thread';
import type { AutomationRecord } from './automation';
import { listTaskStagingRefs, branchAheadCount } from '../worktree/manager';

export interface GithubIssueItem {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

/** gh 输出解析（纯函数，测试锚点）。 */
export function parseIssuesFromGhOutput(stdout: string): GithubIssueItem[] {
  const raw = JSON.parse(stdout) as Array<{ number?: unknown; title?: unknown; body?: unknown; labels?: unknown }>;
  const items: GithubIssueItem[] = [];
  for (const r of raw) {
    if (typeof r.number !== 'number' || typeof r.title !== 'string') continue;
    const labels = Array.isArray(r.labels)
      ? r.labels.map((l) => (typeof l === 'string' ? l : String((l as { name?: unknown })?.name ?? ''))).filter(Boolean)
      : [];
    items.push({ number: r.number, title: r.title, body: typeof r.body === 'string' ? r.body : '', labels });
  }
  return items;
}

function ghFetch(repo: string, labelFilter?: string): Promise<GithubIssueItem[]> {
  return new Promise((resolve, reject) => {
    const args = ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '50', '--json', 'number,title,body,labels'];
    if (labelFilter) args.push('--label', labelFilter);
    const child = spawn('gh', args, { env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { err += String(c); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AppError(ErrorCode.VALIDATION, `gh issue list 超时（${repo}）`));
    }, 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new AppError(ErrorCode.VALIDATION, `gh issue list 失败（exit ${code}）：${err.slice(0, 200) || out.slice(0, 200)}`));
        return;
      }
      try {
        resolve(parseIssuesFromGhOutput(out));
      } catch (e) {
        reject(new AppError(ErrorCode.VALIDATION, `gh 输出解析失败：${String(e).slice(0, 120)}`));
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new AppError(ErrorCode.VALIDATION, `gh 不可用（请确认已安装并登录）：${String(e)}`));
    });
  });
}

/** 分诊任务的教学指令（负责人的活：分类是 agent 的职责，自由判断非固定枚举——用户定案）。 */
function triageInstruction(issue: GithubIssueItem, repo: string): string {
  return [
    `GitHub 仓库 ${repo} 有一个新 issue 需要你分诊处理：`,
    `#${issue.number} ${issue.title}${issue.labels.length ? `（labels: ${issue.labels.join(', ')}）` : ''}`,
    issue.body ? `正文摘要：${issue.body.slice(0, 600)}` : '（无正文）',
    '',
    '你的职责（分诊→验证→派发）：',
    '1. 分类：自行判断这是真缺陷 / 功能请求 / 疑问 / 无法复现（自由判断，不必套固定分类）；',
    '2. 验证：像 bug 的先在代码里核实是否真实存在、能否复现——不存在的不要开工，回复结论并忽略；',
    `3. 需要处理的：通过 outboundTasks 建子任务（标题以「[Issue #${issue.number}]」开头）派给合适的人选/专家，修复工作走正常任务管线；`,
    '4. 铁律：所有修复产物只会落在任务集成区，等用户审批合并——绝不尝试自行合并主干或 push 远端。',
  ].join('\n');
}

export interface SyncResult {
  newCount: number;
  skipped: number;
}

/**
 * 同步一个 github-issues 自动化：拉取开放 issues，未记账的建分诊任务派负责人。
 * fetcher 可注入（测试）；gh 失败抛错由调用方记 health（跳过本轮不轰炸）。
 */
export async function syncGithubIssues(
  db: DB,
  automation: AutomationRecord,
  opts: { fetcher?: (repo: string, labelFilter?: string) => Promise<GithubIssueItem[]> } = {},
): Promise<SyncResult> {
  const repo = automation.config.repo;
  if (!repo) throw new AppError(ErrorCode.VALIDATION, '自动化缺少 repo 配置');
  if (!automation.projectId) throw new AppError(ErrorCode.VALIDATION, 'github-issues 自动化必须绑定项目');
  const fetcher = opts.fetcher ?? ghFetch;
  const issues = await fetcher(repo, automation.config.labelFilter);

  const project = getProject(db, automation.projectId);
  const leadAgentId = project.firstAgentId;
  if (!leadAgentId) throw new AppError(ErrorCode.VALIDATION, `项目「${project.name}」缺少负责人，无法派发 issue 分诊`);
  ensurePrimaryThread(db, project.id, leadAgentId);

  let newCount = 0;
  let skipped = 0;
  const now = nowIso();
  for (const issue of issues) {
    const existing = db.prepare('SELECT id FROM github_issue_sync WHERE repo=? AND number=?').get(repo, issue.number);
    if (existing) {
      skipped += 1;
      continue;
    }
    const task = createTask(db, {
      projectId: project.id,
      assigneeAgentId: leadAgentId,
      title: `[Issue] #${issue.number} ${issue.title.slice(0, 60)}`,
      priority: 5,
      inputProtocol: {
        githubIssue: { repo, number: issue.number, title: issue.title, labels: issue.labels },
        instruction: triageInstruction(issue, repo),
      },
    });
    db.prepare(
      'INSERT INTO github_issue_sync (id, repo, number, project_id, task_id, title, status, synced_at, updated_at) VALUES (?,?,?,?,?,?,?, ?, ?)',
    ).run(shortId('gis_'), repo, issue.number, project.id, task.id, issue.title, 'dispatched', now, now);
    newCount += 1;
  }
  log.info('github issues synced', { automationId: automation.id, repo, newCount, skipped });
  return { newCount, skipped };
}

export interface IssueBoardItem {
  repo: string;
  number: number;
  title: string;
  status: string;
  taskId: string | null;
  taskState: string | null;
  taskSeq: number | null;
  projectTaskId: string | null;
  /** 集成区领先提交数（任务未完成/无产物时为 0）；>0 即「待审批合并」。 */
  aheadCommits: number;
  syncedAt: string;
}

/** Issue 处理看板（整改 Part2 批次7）：issue → 分诊任务状态 → 集成区领先数（待审批标识）。 */
export function listIssueBoard(db: DB, projectId?: string): IssueBoardItem[] {
  const rows = db.prepare(
    `SELECT g.repo, g.number, g.title, g.status, g.task_id, g.synced_at,
            t.state AS task_state, t.seq AS task_seq, t.project_task_id
     FROM github_issue_sync g
     LEFT JOIN task t ON t.id = g.task_id
     ${projectId ? 'WHERE g.project_id = ?' : ''}
     ORDER BY g.synced_at DESC`,
  ).all(...(projectId ? [projectId] : [])) as Array<{
    repo: string; number: number; title: string; status: string; task_id: string | null; synced_at: string;
    task_state: string | null; task_seq: number | null; project_task_id: string | null;
  }>;
  // 集成区领先数按项目批量取（for-each-ref 一次/项目）；resolved 不再算——
  // 每次 ahead 都是 git 子进程，历史 issue 无限累积会让轮询越来越重
  const aheadByProjectTask = new Set<string>();
  for (const r of rows) {
    if (r.project_task_id && r.task_state === 'completed' && r.status !== 'resolved') aheadByProjectTask.add(r.project_task_id);
  }
  // 取所在项目：project_task → project
  const ptToProject = new Map<string, string>();
  for (const pt of aheadByProjectTask) {
    const p = db.prepare('SELECT project_id FROM project_task WHERE id=?').get(pt) as { project_id: string } | undefined;
    if (p) ptToProject.set(pt, p.project_id);
  }
  const aheadCache = new Map<string, Map<string, { branch: string; head: string; lastCommitAt: string }>>();
  const aheadRootCache = new Map<string, string>();
  for (const pid of new Set(ptToProject.values())) {
    const project = getProject(db, pid);
    // 修复轮 Fix4：任务级集成分支在载体/锚点仓库（只读窥探）
    const root = peekRepoRoot(db, project) ?? project.rootDir;
    aheadRootCache.set(pid, root);
    aheadCache.set(pid, listTaskStagingRefs(root, pid));
  }
  const aheadOf = (pt: string): number => {
    const pid = ptToProject.get(pt);
    if (!pid) return 0;
    const refs = aheadCache.get(pid);
    const ref = refs?.get(pt);
    if (!ref) return 0;
    return branchAheadCount(aheadRootCache.get(pid) ?? getProject(db, pid).rootDir, ref.branch);
  };
  return rows.map((r) => ({
    repo: r.repo,
    number: r.number,
    title: r.title,
    status: r.status,
    taskId: r.task_id,
    taskState: r.task_state,
    taskSeq: r.task_seq,
    projectTaskId: r.project_task_id,
    aheadCommits: r.project_task_id && r.task_state === 'completed' && r.status !== 'resolved' ? aheadOf(r.project_task_id) : 0,
    syncedAt: r.synced_at,
  }));
}

/**
 * promote 成功后的 issue 记账收口：该任务链（project_task 下所有 runtime task）源自 issue 的记账置 resolved。
 * 否则 status 恒为 dispatched，看板会为每条历史 issue 永久计算集成区领先（无界轮询）。
 */
export function markIssueSyncsResolved(db: DB, projectTaskId: string): number {
  const r = db.prepare(
    "UPDATE github_issue_sync SET status='resolved', updated_at=? WHERE status<>'resolved' AND task_id IN (SELECT id FROM task WHERE project_task_id=?)",
  ).run(nowIso(), projectTaskId);
  return r.changes;
}
