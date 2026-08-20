/**
 * 首次启动引导（First-Run Setup）。
 *
 * 提供：
 * - 状态检测：是否已完成引导、当前工作区、建议目录。
 * - 目录设定：用户选择路径时，空目录直接用；非空则嵌套预设名子文件夹，
 *   避免把程序文件混进用户已有内容的目录。
 * - 完成标记：写入 system_setting，之后不再弹出引导。
 */
import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/client';
import { asyncHandler } from './middleware';
import { getSetting, setSetting } from '../domain/setting';
import { createWorkspace, getActiveWorkspace, migrateWorkspace } from '../domain/workspace';
import { defaultWorkspaceRoot } from '../domain/workspace-layout';

export const setupRouter = Router();

/**
 * 预设的工作区目录名（用户不指定时用 ~/ 下的这个名字）。
 * 默认根跟随 MUSTER_HOME（测试隔离），见 workspace-layout.defaultWorkspaceRoot。
 */
const DEFAULT_WORKSPACE_NAME = 'MusterWorkspace';

/** 默认工作区目录（= defaultWorkspaceRoot：未设 MUSTER_HOME 时即 ~/MusterWorkspace）。 */
function defaultWorkspaceDir(): string {
  return defaultWorkspaceRoot();
}

/**
 * GET /api/setup/status
 * 返回：引导是否完成、当前工作区、建议目录（含是否会被嵌套的说明）。
 */
setupRouter.get('/status', asyncHandler(async (_req, res) => {
  const db = getDb();
  const done = getSetting(db, 'setup_wizard_done', '') === '1';
  const active = getActiveWorkspace(db);
  const defaultDir = defaultWorkspaceDir();
  res.json({
    done,
    hasWorkspace: Boolean(active),
    currentWorkspace: active ? { id: active.id, rootDir: active.rootDir } : null,
    suggested: {
      defaultDir,
      // 默认目录是否已存在/非空（决定「直接用 vs 嵌套」）
      exists: fs.existsSync(defaultDir),
      isEmpty: fs.existsSync(defaultDir) ? fs.readdirSync(defaultDir).length === 0 : true,
    },
  });
}));

/**
 * POST /api/setup/workspace { rootDir?: string }
 * 设定工作区目录。
 * - 不传 rootDir：用默认 ~/MusterWorkspace。
 * - 传 rootDir：目标为空/不存在 → 直接用；非空 → 嵌套 <预设名> 子文件夹（并说明）。
 * - 若已有 workspace（重复进入引导），仅重命名/切换路径，不重复创建。
 */
setupRouter.post('/workspace', asyncHandler(async (req, res) => {
  const input = z.object({ rootDir: z.string().optional() }).parse(req.body);
  const db = getDb();
  const chosen = input.rootDir?.trim() || defaultWorkspaceDir();
  const resolved = path.resolve(chosen);

  let finalDir = resolved;
  let nested = false;
  // 默认目录（~/MusterWorkspace）即使已有内容也直接使用——它就是 Muster 自己的工作区，
  // 避免递归嵌套成 MusterWorkspace/MusterWorkspace。
  const isDefaultDir = resolved === defaultWorkspaceDir();
  if (!isDefaultDir && fs.existsSync(resolved)) {
    const entries = fs.readdirSync(resolved);
    if (entries.length > 0) {
      // 非空目录：嵌套预设名子文件夹，避免混入用户已有内容
      finalDir = path.join(resolved, DEFAULT_WORKSPACE_NAME);
      nested = true;
    }
  }
  // 确保最终目录存在（嵌套子目录也需要创建）
  fs.mkdirSync(finalDir, { recursive: true });

  const existing = getActiveWorkspace(db);
  if (existing) {
    // 已有工作区：走完整迁移（含前置校验 + 文件移动 + 前缀重映射），
    // 避免「DB 指向新目录但旧文件仍在原处」的不一致（即使引导阶段一般无文件，也要安全）。
    migrateWorkspace(db, existing.id, finalDir);
  } else {
    createWorkspace(db, { name: '主工作区', rootDir: finalDir });
  }

  res.json({ rootDir: finalDir, nested, exists: fs.existsSync(finalDir) });
}));

/** POST /api/setup/complete 标记引导完成。 */
setupRouter.post('/complete', asyncHandler(async (_req, res) => {
  setSetting(getDb(), 'setup_wizard_done', '1');
  res.json({ ok: true });
}));
