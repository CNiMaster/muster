/**
 * 本地备份 REST 路由。
 *
 * - GET    /api/backup/export          导出全部结构化配置为 JSON（下载）
 * - POST   /api/backup/import          上传备份 JSON 导入
 * - GET    /api/backup/directories     文件系统目录指引（哪些目录需要用户自行备份）
 */
import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/client';
import { asyncHandler } from './middleware';
import { exportMusterBackup, importMusterBackup, BACKUP_FORMAT, BACKUP_VERSION } from '../domain/backup-export';
import { getMusterDirectories } from '../domain/muster-directories';
import { scanSystemCliCapabilities } from '../domain/system-scan';
import { installPlugin } from '../domain/plugin-install';
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';

export const backupRouter = Router();

// 导出：返回 JSON（浏览器触发下载）
backupRouter.get('/export', asyncHandler(async (_req, res) => {
  const backup = exportMusterBackup(getDb());
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="muster-backup-${date}.json"`);
  res.json(backup);
}));

// 导入：body 为备份 JSON
backupRouter.post('/import', asyncHandler(async (req, res) => {
  const body = req.body as unknown;
  if (!body || typeof body !== 'object' || (body as { format?: unknown }).format !== BACKUP_FORMAT) {
    res.status(400).json({ error: { code: 'validation', message: `无效的备份文件（需要 format=${BACKUP_FORMAT}，当前版本=${BACKUP_VERSION}）` } });
    return;
  }
  const summary = importMusterBackup(getDb(), body as Parameters<typeof importMusterBackup>[1]);
  res.json(summary);
}));

// 文件系统目录指引
/** 批次 L1：迁移前自动快照清单（备份中心展示+恢复指引）。 */
backupRouter.get('/pre-migration-snapshots', asyncHandler(async (_req, res) => {
  const { listPreMigrationSnapshots } = await import('../db/client');
  res.json(listPreMigrationSnapshots());
}));

/** 批次 L5：过期信息清理——预览（分类数量+样本，用户确认前所见即所得）。 */
backupRouter.get('/cleanup-preview', asyncHandler(async (_req, res) => {
  const { previewCleanup } = await import('../domain/retention');
  res.json(previewCleanup(getDb()));
}));

/** 批次 L5+L6：执行清理（归档 JSONL.gz 可找回→删除→checkpoint+VACUUM）。 */
backupRouter.post('/cleanup-run', asyncHandler(async (req, res) => {
  const { executeCleanup } = await import('../domain/retention');
  const body = (req.body ?? {}) as { traceEvents?: boolean; audits?: boolean };
  res.json(executeCleanup(getDb(), { traceEvents: body.traceEvents !== false, audits: body.audits !== false }));
}));

backupRouter.get('/directories', asyncHandler(async (_req, res) => {
  res.json(getMusterDirectories(getDb()));
}));

// 扫描系统常见 CLI（Claude Code / Codex / OpenCode / agents）的 skills 与 MCP 配置
backupRouter.post('/scan-system', asyncHandler(async (_req, res) => {
  res.json(scanSystemCliCapabilities());
}));

/**
 * 导入扫描到的能力为 Muster 插件。
 * body: { skills: {provider,id}[], mcps: {provider,name}[] }（来自 /scan-system 的多选结果）
 * - 安全：前端只传 provider+id，文件路径由服务端重新扫描定位（不允许客户端指定任意路径）。
 * - skill：读取 SKILL.md 全文存入 plugin.manifest.skill.body（不依赖文件位置，可进备份）。
 * - mcp：command/url 存入 manifest，envKeys 只存键名（不读值）。
 */
backupRouter.post('/import-scanned', asyncHandler(async (req, res) => {
  const input = z.object({
    skills: z.array(z.object({
      provider: z.string(),
      id: z.string(),
      name: z.string(),
    })).default([]),
    mcps: z.array(z.object({
      provider: z.string(),
      name: z.string(),
    })).default([]),
  }).parse(req.body);

  // 服务端重新扫描，建立 provider+id/name → 实际路径 的映射（防止客户端传任意路径读文件）
  const scan = scanSystemCliCapabilities();
  const skillByKey = new Map(scan.skills.map((s) => [`${s.provider}:${s.id}`, s]));
  const mcpByKey = new Map(scan.mcps.map((m) => [`${m.provider}:${m.name}`, m]));

  const db = getDb();
  const imported: string[] = [];
  const skipped: string[] = [];

  // skills：读 SKILL.md 全文 → 注册为 skill 插件
  for (const skill of input.skills) {
    const found = skillByKey.get(`${skill.provider}:${skill.id}`);
    if (!found) {
      skipped.push(`skill:${skill.id}（扫描结果中不存在，请重新扫描）`);
      continue;
    }
    let body = '';
    try {
      body = fs.readFileSync(found.path, 'utf8');
    } catch {
      skipped.push(`skill:${skill.id}（读取失败）`);
      continue;
    }
    const pluginId = `sys-skill-${skill.provider}-${skill.id}`;
    installPlugin(db, {
      id: pluginId,
      name: found.name, // 用扫描结果的名字，不信任前端传入
      kind: 'skill',
      source: { kind: 'executor-native', provider: skill.provider },
      scope: { level: 'platform' },
      manifest: { kind: 'skill', skill: { body, frontmatter: { sourcePath: found.path } } },
      maturity: 'stable',
    });
    imported.push(pluginId);
    realtime.publish(makeLifecycleEvent('plugin.installed', { pluginId }, {}));
  }

  // MCP：注册为 mcp-server 插件（env 只存键名引用）。
  // 配置同样来自服务端扫描结果（mcpByKey），不信任前端提交的 command/url/envKeys。
  for (const mcp of input.mcps) {
    const found = mcpByKey.get(`${mcp.provider}:${mcp.name}`);
    if (!found) {
      skipped.push(`mcp:${mcp.name}（扫描结果中不存在，请重新扫描）`);
      continue;
    }
    const pluginId = `sys-mcp-${mcp.provider}-${mcp.name}`;
    installPlugin(db, {
      id: pluginId,
      name: mcp.name,
      kind: 'mcp-server',
      source: { kind: 'executor-native', provider: mcp.provider },
      scope: { level: 'platform' },
      manifest: {
        kind: 'mcp-server',
        mcp: found.url
          ? { transport: 'sse', url: found.url, env: undefined, headers: undefined }
          : { transport: 'stdio', command: found.command, args: found.args, env: undefined },
      },
      credentialKeys: found.envKeys,
      maturity: 'stable',
    });
    imported.push(pluginId);
    realtime.publish(makeLifecycleEvent('plugin.installed', { pluginId }, {}));
  }

  res.json({ imported, skipped });
}));
