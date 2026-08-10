import { Router } from 'express';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { asyncHandler } from './middleware';
import { getDb } from '../db/client';
import { getSystemSettings, saveSystemSettings } from '../domain/setting';
import { log } from '../logger';

const execFileAsync = promisify(execFile);

export const settingsRouter = Router();

// 获取当前系统设置
settingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const settings = getSystemSettings(db);
    res.json(settings);
  }),
);

// 保存系统设置
settingsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      claudeBin: z.string().min(1),
      model: z.string().max(200),
      skipPermissions: z.boolean(),
      timeoutMs: z.number().min(1000),
      maxToolCalls: z.number().min(1),
      // Batch 14：多执行器配置（可选，向后兼容）
      defaultProvider: z.enum(['claude-cli', 'codex-cli', 'antigravity-cli', 'custom-cli', 'openai', 'gemini']).optional(),
      openaiBaseURL: z.string().max(500).optional(),
      openaiModel: z.string().max(200).optional(),
      geminiModel: z.string().max(200).optional(),
      // 阶段二任务 2.1：三级默认执行器 profile id（空串 = 未配置）
      executorTierPrimaryId: z.string().max(100).optional(),
      executorTierSecondaryId: z.string().max(100).optional(),
      executorTierTertiaryId: z.string().max(100).optional(),
    });
    const input = schema.parse(req.body);
    const db = getDb();
    saveSystemSettings(db, input);
    res.json({ ok: true, settings: getSystemSettings(db) });
  }),
);

// 连通性测试与桥接测试
settingsRouter.post(
  '/test-connection',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      claudeBin: z.string().optional(),
      model: z.string().max(200).optional(),
    });
    const { claudeBin, model } = schema.parse(req.body);
    const db = getDb();
    const settings = getSystemSettings(db);
    const activeBin = claudeBin || settings.claudeBin;
    const activeModel = model?.trim() ?? settings.model;

    log.info('testing connection for claudeBin', { bin: activeBin });

    // 1. 连通性测试：获取版本
    let versionOutput = '';
    let versionError = '';
    let versionSuccess = false;
    let versionDurationMs = 0;

    const startVersion = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(activeBin, ['--version'], { timeout: 5000 });
      versionOutput = stdout.trim();
      versionError = stderr.trim();
      versionSuccess = true;
    } catch (err: any) {
      versionError = err.message || String(err);
    }
    versionDurationMs = Date.now() - startVersion;

    // 2. 桥接测试：LLM 轻量对话测试 (只有第一步成功才跑第二步)
    let bridgeOutput = '';
    let bridgeError = '';
    let bridgeSuccess = false;
    let bridgeDurationMs = 0;

    if (versionSuccess) {
      const startBridge = Date.now();
      try {
        // 使用 -p + --print 做非交互式轻量单次对话，限定 15s 超时
        const bridgeArgs = [
          '-p',
          '测试系统连通性。请用中文回答"桥接正常"，不要添加任何其他字符。',
          '--print',
          '--tools',
          '',
          '--disable-slash-commands',
        ];
        if (activeModel) bridgeArgs.push('--model', activeModel);
        const { stdout, stderr } = await execFileAsync(
          activeBin,
          bridgeArgs,
          { timeout: 15000 }
        );
        bridgeOutput = stdout.trim();
        bridgeError = stderr.trim();
        bridgeSuccess = true;
      } catch (err: any) {
        bridgeError = err.message || String(err);
      }
      bridgeDurationMs = Date.now() - startBridge;
    }

    res.json({
      claudeBin: activeBin,
      model: activeModel,
      versionTest: {
        success: versionSuccess,
        durationMs: versionDurationMs,
        output: versionOutput,
        error: versionError,
      },
      bridgeTest: {
        success: bridgeSuccess,
        durationMs: bridgeDurationMs,
        output: bridgeOutput,
        error: bridgeError,
      },
      overallSuccess: versionSuccess && bridgeSuccess,
    });
  }),
);
