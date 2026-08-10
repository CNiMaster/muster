import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { asyncHandler, param } from './middleware';
import { BUILTIN_EXECUTOR_MANIFESTS } from '../executors/manifests';
import { bindDetectedSystemExecutor, detectSystemExecutor, testExecutorProfileConnection } from '../domain/executor-discovery';
import { bindEmployeeExecutorProfile, createExecutorProfile, deleteExecutorProfile, listExecutorProfiles, updateExecutorProfile } from '../domain/executor-profile';
import{getConnectionProbe,startConnectionProbe}from'../domain/connection-probe';
import { ClaudeSetupGenerator } from '../domain/setup-assistant';
import { generateCliProposal } from '../domain/cli-assistant';
import { diagnoseInstallError, runInstallStream, type InstallEvent } from '../domain/executor-install';

export const executorsRouter = Router();

// AI 引导自定义 CLI 接入：描述 CLI → 生成检测命令/参数模板/安装说明（内置模板或 Claude 生成）
executorsRouter.post('/assistant/cli-proposal', asyncHandler(async (req, res) => {
  const input = z.object({ prompt: z.string().min(1).max(500) }).parse(req.body);
  res.json(await generateCliProposal(input, new ClaudeSetupGenerator(getDb())));
}));

executorsRouter.get('/manifests', asyncHandler(async (_req,res)=>res.json(BUILTIN_EXECUTOR_MANIFESTS)));

// 一键检测全部可检测的 CLI（并行），返回每个的 found/path/version。
// 用 allSettled 隔离单个检测失败（如异常路径），避免一个 CLI 检测出错拖垮全部。
executorsRouter.post('/detect-all', asyncHandler(async (_req,res)=>{
  const manifests = BUILTIN_EXECUTOR_MANIFESTS.filter((m) => m.detection);
  const settled = await Promise.allSettled(
    manifests.map(async (m) => ({
      manifestId: m.id,
      displayName: m.displayName,
      ...(await detectSystemExecutor(m.id)),
    })),
  );
  res.json(settled.map((s, i) => s.status === 'fulfilled'
    ? s.value
    : { manifestId: manifests[i].id, displayName: manifests[i].displayName, found: false, path: null, version: null, managed: false }));
}));

// 一键安装 CLI：SSE 流式推送安装日志；完成后自动检测+绑定。
// 安装失败的 AI 诊断由前端在收到 error 事件后调用 /install-diagnose 端点完成。
executorsRouter.post('/:manifestId/install', async (req, res) => {
  const manifestId = param(req, 'manifestId');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  let closed = false;
  // 客户端断开（如安装途中关页面）时 res.write 会抛错；静默停止推送，避免未处理异常。
  req.on('close', () => { closed = true; });
  const send = (event: InstallEvent): void => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      closed = true;
    }
  };
  try {
    await runInstallStream(getDb(), manifestId, undefined, send);
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error), exitCode: null });
  }
  if (!closed) res.end();
});

// AI 诊断安装失败：body: { manifestId, command, output, exitCode }
executorsRouter.post('/install-diagnose', asyncHandler(async (req,res)=>{
  const input = z.object({
    manifestId: z.string().min(1),
    command: z.string().min(1),
    output: z.string().default(''),
    exitCode: z.number().nullish(),
  }).parse(req.body);
  res.json(await diagnoseInstallError({
    manifestId: input.manifestId,
    command: input.command,
    output: input.output,
    exitCode: input.exitCode ?? null,
  }, new ClaudeSetupGenerator(getDb())));
}));
executorsRouter.get('/profiles', asyncHandler(async (_req,res)=>{
  const db=getDb();
  res.json(listExecutorProfiles(db).map((profile)=>({
    ...profile,
    connection:db.prepare("SELECT status,classification,version,completed_at completedAt FROM connection_probe WHERE executor_profile_id=? AND kind='connectivity' ORDER BY created_at DESC,id DESC LIMIT 1").get(profile.id)??null,
    capability:db.prepare("SELECT status,classification,capability_json capabilityJson,completed_at completedAt FROM connection_probe WHERE executor_profile_id=? AND kind='capability' ORDER BY created_at DESC,id DESC LIMIT 1").get(profile.id)??null,
  })));
}));
executorsRouter.post('/profiles', asyncHandler(async (req,res)=>{const input=z.object({name:z.string().min(1),manifestId:z.string(),config:z.record(z.unknown()).optional(),credentialRef:z.object({kind:z.enum(['env','keychain','cli-login','encrypted-local']),reference:z.string().min(1)}).optional(),install:z.record(z.unknown()).optional(),concurrencyMode:z.enum(['parallel','profile-serial','global-serial']).optional()}).parse(req.body);res.status(201).json(createExecutorProfile(getDb(),input));}));

// 阶段二任务 2.2：更新执行器档案（名称/配置/凭据/并发模式）
executorsRouter.put('/profiles/:id', asyncHandler(async (req,res)=>{
  const input = z.object({
    name: z.string().min(1).optional(),
    config: z.record(z.unknown()).optional(),
    credentialRef: z.object({ kind: z.enum(['env','keychain','cli-login','encrypted-local']), reference: z.string().min(1) }).optional(),
    concurrencyMode: z.enum(['parallel','profile-serial','global-serial']).optional(),
  }).parse(req.body);
  res.json(updateExecutorProfile(getDb(), param(req, 'id'), input));
}));

// 阶段二任务 2.2：删除执行器档案（解除员工绑定 + 清理探针记录）
executorsRouter.delete('/profiles/:id', asyncHandler(async (req,res)=>{
  deleteExecutorProfile(getDb(), param(req, 'id'));
  res.json({ ok: true });
}));
executorsRouter.put('/employees/:employeeId/profile/:executorProfileId', asyncHandler(async (req,res)=>{bindEmployeeExecutorProfile(getDb(),param(req,'employeeId'),param(req,'executorProfileId'));res.json({ok:true});}));
executorsRouter.post('/:manifestId/detect', asyncHandler(async (req,res)=>res.json(await detectSystemExecutor(param(req,'manifestId')))));
executorsRouter.post('/:manifestId/bind-system', asyncHandler(async (req,res)=>{const profile=await bindDetectedSystemExecutor(getDb(),param(req,'manifestId'));startConnectionProbe(getDb(),{profileId:profile.id,force:false,kind:'connectivity'});res.status(201).json(profile);}));
executorsRouter.post('/profiles/:id/test', asyncHandler(async (req,res)=>res.json(await testExecutorProfileConnection(getDb(),param(req,'id')))));
executorsRouter.post('/profiles/:id/probes',asyncHandler(async(req,res)=>{const input=z.object({force:z.boolean().default(false),kind:z.enum(['connectivity','model','capability']).default('connectivity')}).parse(req.body??{});res.status(202).json(startConnectionProbe(getDb(),{profileId:param(req,'id'),force:input.force,kind:input.kind}));}));
executorsRouter.get('/probes/:id',asyncHandler(async(req,res)=>res.json(getConnectionProbe(getDb(),param(req,'id')))));
