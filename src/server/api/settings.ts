import { Router } from 'express';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { asyncHandler } from './middleware';
import { getDb } from '../db/client';
import { saveSystemSettings, getSystemSettings } from '../domain/setting';
import { log } from '../logger';

const execFileAsync = promisify(execFile);

export const settingsRouter = Router();

/** 治理批次5：界面模式切换（轻量专用端点——主批量端点 schema 必填全量，不适合单键切换）。 */
settingsRouter.post(
  '/ui-mode',
  asyncHandler(async (req, res) => {
    const input = z.object({ uiMode: z.enum(['simple', 'pro']) }).parse(req.body);
    saveSystemSettings(getDb(), { uiMode: input.uiMode });
    res.json({ uiMode: input.uiMode });
  }),
);

/** 工作台快速指引完成标记（轻量专用端点——同 ui-mode 先例：主端点必填全量，单键提交会被 422 拒掉）。 */
settingsRouter.post(
  '/workbench-guide',
  asyncHandler(async (req, res) => {
    const input = z.object({ done: z.boolean() }).parse(req.body);
    saveSystemSettings(getDb(), { workbenchGuideDone: input.done });
    res.json({ ok: true });
  }),
);

/** 保存系统设置的 zod schema（导出供测试——六步链断点历史上就出在这里：zod 默认剥未知键）。 */
export const settingsUpdateSchema = z.object({
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
  // 执行器池统一（2026-08-17）：高/标准/低档 = 档案 id
  executorTierHighId: z.string().max(100).optional(),
  executorTierStandardId: z.string().max(100).optional(),
  executorTierLowId: z.string().max(100).optional(),
  // settings-overhaul（spec 2026-08-12-settings-overhaul-design）
  proxyUrl: z.string().max(500).optional(),
  proxyBypass: z.string().max(1000).optional(),
  caCertPath: z.string().max(1000).optional(),
  egressTimeoutMs: z.number().min(1000).max(600000).optional(),
  theme: z.enum(['dark', 'light', 'system']).optional(),
  fontFamily: z.string().max(200).optional(),
  fontSize: z.number().min(8).max(32).optional(),
  locale: z.enum(['zh', 'en']).optional(),
  codeTheme: z.string().max(100).optional(),
  // 2026-08-25 代码显示：字号与长行换行（CSS 变量注入，消费点 mu-md-code）
  codeFontSize: z.number().int().min(10).max(24).optional(),
  wrapCode: z.boolean().optional(),
  // E4.3 空闲自主反思（默认关）
  autonomousReflectionEnabled: z.boolean().optional(),
  autonomousReflectionBudgetUSD: z.number().min(0).optional(),
  // 指挥系统：晨醒开关 + 蜂群限额 + 对抗评审置信阈值
  swarmMaxDepth: z.number().int().min(1).max(5).optional(),
  swarmMaxWidth: z.number().int().min(1).max(20).optional(),
  swarmMaxNodes: z.number().int().min(1).max(300).optional(),
  swarmBudgetUSD: z.number().min(0).optional(),
  debateMinConfidence: z.number().min(0.5).max(0.95).optional(),
  // 执行过程展示批次4：蜂群失败自动修复全群上限
  swarmRepairMax: z.number().int().min(1).max(100).optional(),
  // 三档广深（B2）：新任务默认档位（任务级 inputProtocol.breadthTier 可覆盖）
  breadthDefaultTier: z.enum(['light', 'standard', 'heavy']).optional(),
  // WP9 模型档位（空串 = 未配置不覆盖；标准档 = 不覆盖故无键）
  modelTierEconomy: z.string().max(200).optional(),
  modelTierPremium: z.string().max(200).optional(),
  // WP10 图像生成模型（image_generate 工具）
  imageGenModel: z.string().max(200).optional(),
  // 批次 F.4：waiting_input 超时自动继续分钟数（0=一直等，默认；任务级可覆盖）
  waitingAutoContinueMinutes: z.number().int().min(0).max(1440).optional(),
  // R2b 任务自动归档保留天数（completed 超 N 天自动归档；0=关闭，默认 30）
  archiveTaskAfterDays: z.number().int().min(0).max(3650).optional(),
  preventSleep: z.enum(['active', 'always', 'off']).optional(),
  interruptMode: z.enum(['queue', 'interrupt']).optional(),
  // H8 安全停：请求停止后等执行边界的超时毫秒数（5s-10min，默认 60s）
  stopGraceMs: z.number().int().min(5000).max(600000).optional(),
  // H9b 全局默认权限档（''跟随策略）
  securityMode: z.enum(['', 'confirm-edits', 'auto-edit', 'plan', 'full-access']).optional(),
  // 工作台快速指引完成标记（服务端记录，多端共享）
  workbenchGuideDone: z.boolean().optional(),
  // 消息流工作块（2026-08-23）：思考过程/待办卡片/三分组显示开关
  messageShowThinking: z.boolean().optional(),
  messageShowTodo: z.boolean().optional(),
  messageGroupExplore: z.boolean().optional(),
  messageGroupTerminal: z.boolean().optional(),
  messageGroupChanges: z.boolean().optional(),
});

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
    const input = settingsUpdateSchema.parse(req.body);
    const db = getDb();
    saveSystemSettings(db, input);
    res.json({ ok: true, settings: getSystemSettings(db) });
  }),
);

// H9b：安全审查留档查询（工作现场/项目维度复盘）
settingsRouter.get(
  '/security-audits',
  asyncHandler(async (req, res) => {
    const { listSecurityAudits } = await import('../domain/security-audit');
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(listSecurityAudits(getDb(), { projectId, taskId, limit: Number.isFinite(limit) ? limit : undefined }));
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
