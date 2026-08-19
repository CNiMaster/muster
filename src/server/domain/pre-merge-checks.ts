/**
 * promote 前确定性检查（整改批次 2）。
 *
 * 门禁现状全是语义审查（验收员/premium 审查都不真跑检查）——本模块补"真的跑"这层：
 * 在任务级集成 worktree 上执行项目配置的检查命令（typecheck 类），失败 → 本轮跳过 + 播报，
 * 与 concern 同语义（不阻塞下轮）。执行口径复用 run_command 的成熟安全约定：
 * 异步 spawn（不阻塞事件循环）、60s 缺省/300s 上限超时、环境白名单清洗、输出截断。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client';
import { getProject } from './project';
import { sanitizeChildEnv } from '../executors/tools/registry';

export interface PreMergeCheck {
  name: string;
  command: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const OUTPUT_CAP = 8 * 1024;

/**
 * 检查命令解析：项目 settings_json.preMergeChecks 显式配置优先；
 * 未配置时探测项目根 package.json scripts 含 typecheck → 默认 [npm run typecheck]；
 * 都无 → 空（非 JS 项目不阻塞，promote 只走语义审查）。
 */
export function getPreMergeChecks(db: DB, projectId: string): PreMergeCheck[] {
  const project = getProject(db, projectId);
  const configured = (project.settings as Record<string, unknown>)?.preMergeChecks;
  if (Array.isArray(configured)) {
    const checks: PreMergeCheck[] = [];
    for (const item of configured) {
      const c = item as { name?: unknown; command?: unknown };
      if (typeof c?.command === 'string' && c.command.trim()) {
        checks.push({ name: typeof c.name === 'string' && c.name.trim() ? c.name : c.command.slice(0, 40), command: c.command });
      }
    }
    return checks;
  }
  try {
    const pkgPath = path.join(project.rootDir, 'package.json');
    if (!existsSync(pkgPath)) return [];
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, unknown> };
    if (pkg.scripts && typeof pkg.scripts.typecheck === 'string') {
      return [{ name: 'typecheck（自动探测）', command: 'npm run typecheck' }];
    }
  } catch { /* 解析失败按无检查处理 */ }
  return [];
}

export interface CheckRunResult {
  ok: boolean;
  failed?: { name: string; command: string; outputTail: string };
}

/** 单命令异步执行（超时杀进程，输出保留尾部）。 */
function runOne(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, env: sanitizeChildEnv(process.env) });
    let output = '';
    const append = (chunk: Buffer | string): void => {
      output += chunk.toString();
      if (output.length > OUTPUT_CAP * 2) output = output.slice(-OUTPUT_CAP * 2);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      output += `\n[muster] 超时 ${timeoutMs}ms，已终止`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(err) });
    });
  });
}

/**
 * 在任务级集成 worktree 上跑全部检查。
 * node_modules 处理：git worktree 不共享依赖——项目根有且 worktree 无时软链过去，
 * 检查完删除软链（防 promote 的 pre-promote commitAll 把依赖卷进集成分支）。
 */
export async function runPreMergeChecks(
  projectRootDir: string,
  stagingPath: string,
  checks: PreMergeCheck[],
): Promise<CheckRunResult> {
  const timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  let linkedModules: string | null = null;
  const rootModules = path.join(projectRootDir, 'node_modules');
  const stagingModules = path.join(stagingPath, 'node_modules');
  try {
    if (existsSync(rootModules) && !existsSync(stagingModules)) {
      try {
        symlinkSync(rootModules, stagingModules, 'junction');
        linkedModules = stagingModules;
      } catch { /* 软链失败不阻塞检查（命令可能不需要依赖） */ }
    }
    for (const check of checks) {
      const { code, output } = await runOne(check.command, stagingPath, timeoutMs);
      if (code !== 0) {
        return {
          ok: false,
          failed: { name: check.name, command: check.command, outputTail: output.slice(-OUTPUT_CAP).trim() || '（无输出）' },
        };
      }
    }
    return { ok: true };
  } finally {
    if (linkedModules) {
      try { rmSync(linkedModules, { force: true }); } catch { /* 清理失败不影响结果 */ }
    }
  }
}
