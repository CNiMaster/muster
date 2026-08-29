import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { recruitAgentProfile } from '../domain/agent';
import {
  createAgentProfile,
  getAgentProfile,
  listAgentProfiles,
  listProfileEmployments,
  updateAgentProfile,
  updateUserCustomConfig,
  cloneProfileAsUser,
  clonePersonaAsUser,
  copyAgentProfile,
  resetAgentProfileToBase,
} from '../domain/agent-profile';
import { asyncHandler, param, companyIdOf } from './middleware';
import { exportCapabilityPackage, materializeAgentHome, syncAgentIdentityFiles, syncAgentMemoryFiles } from '../domain/agent-home';
import { resetPersonalMemory } from '../domain/memory';
import { recruitFromDraft } from '../domain/recruitment';
import { getEmployeeRuntime } from '../domain/employee-runtime';
import { getEmploymentHealth } from '../domain/executor-health';
import { listPersonas, getPersona, listPersonaDomains, searchPersonas, updateUserPersona, deleteUserPersona, type Persona } from '../domain/persona-library';

export const agentProfilesRouter = Router();
export const companyEmployeesRouter = Router({ mergeParams: true });

const recruitmentDraftSchema = z.object({
  source: z.enum(['reuse-profile', 'new-profile']),
  profileId: z.string().optional(),
  displayName: z.string().min(1),
  role: z.string().min(1),
  responsibilities: z.string(),
  capabilities: z.object({ skills: z.array(z.string()), tools: z.array(z.string()) }),
  departmentId: z.string().nullable(),
  executorProfileId: z.string().nullable(),
  permissionPolicyId: z.string().nullable(),
});

const profileSchema = z.object({
  displayName: z.string().min(1),
  soul: z.string().optional(),
  principles: z.array(z.string()).optional(),
  capabilities: z.record(z.unknown()).optional(),
  recommendedExecutor: z.record(z.unknown()).optional(),
  recommendedPermission: z.record(z.unknown()).optional(),
  personaId: z.string().optional(),
  source: z.enum(['user', 'system', 'crystallized']).optional(),
  sourcePersonaId: z.string().nullable().optional(),
  isAutoDispatch: z.number().int().min(0).max(1).optional(),
  customModel: z.string().nullable().optional(),
  customThinkingDepth: z.string().nullable().optional(),
});

const customConfigSchema = z.object({
  displayName: z.string().min(1).optional(),
  soul: z.string().optional(),
  principles: z.array(z.string()).optional(),
  isAutoDispatch: z.number().int().min(0).max(1).optional(),
  customModel: z.string().nullable().optional(),
  customThinkingDepth: z.string().nullable().optional(),
});

agentProfilesRouter.get('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const source = typeof req.query.source === 'string' && (req.query.source === 'user' || req.query.source === 'system' || req.query.source === 'crystallized')
    ? req.query.source
    : undefined;
  const profiles = listAgentProfiles(db, { source });
  const countRows = db.prepare(
    `SELECT profile_id, COUNT(*) as n FROM company_employee GROUP BY profile_id`,
  ).all() as Array<{ profile_id: string; n: number }>;
  const countMap = new Map(countRows.map((r) => [r.profile_id, r.n]));
  res.json(profiles.map((p) => ({ ...p, employmentCount: countMap.get(p.id) ?? 0 })));
}));

/** 人才市场分类聚合视图 */
agentProfilesRouter.get('/market', asyncHandler(async (_req, res) => {
  const db = getDb();
  const allProfiles = listAgentProfiles(db);
  const countRows = db.prepare(
    `SELECT profile_id, COUNT(*) as n FROM company_employee GROUP BY profile_id`,
  ).all() as Array<{ profile_id: string; n: number }>;
  const countMap = new Map(countRows.map((r) => [r.profile_id, r.n]));
  const userTalents = allProfiles.filter((p) => p.source === 'user').map((p) => ({ ...p, employmentCount: countMap.get(p.id) ?? 0 }));
  const crystallizedTalents = allProfiles.filter((p) => p.source === 'crystallized').map((p) => ({ ...p, employmentCount: countMap.get(p.id) ?? 0 }));
  const systemPersonas = listPersonas().map(toPersonaView);
  res.json({
    userTalents,
    crystallizedTalents,
    systemPersonas,
  });
}));

// ===== Persona 专家库 =====

/**
 * 批次 E 复审：对外视图剥离 filePath——服务器绝对路径不进客户端载荷
 * （sections 目录轻量且对 UI 有用，保留）。
 */
function toPersonaView(p: Persona): Omit<Persona, 'filePath'> {
  const { filePath, ...rest } = p;
  return rest;
}

agentProfilesRouter.get('/personas/domains', asyncHandler(async (_req, res) => {
  res.json(listPersonaDomains());
}));

/** 列表/搜索：?domain=marketing&q=关键词 */
agentProfilesRouter.get('/personas', asyncHandler(async (req, res) => {
  const domain = typeof req.query.domain === 'string' && req.query.domain ? req.query.domain : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const result = q ? searchPersonas(q) : listPersonas(domain);
  res.json(result.map(toPersonaView));
}));

agentProfilesRouter.get('/personas/:personaId', asyncHandler(async (req, res) => {
  const persona = getPersona(param(req, 'personaId'));
  if (!persona) {
    res.status(404).json({ error: '专家不存在' });
    return;
  }
  res.json(toPersonaView(persona));
}));

// ===== WP3 自建人设「改/删」（仅 user/ 前缀；预置库只读） =====

const userPersonaPatchSchema = z.object({
  name: z.string().min(1).max(30).optional(),
  description: z.string().max(160).optional(),
  soul: z.string().max(2000).optional(),
  principles: z.array(z.string().max(80)).max(8).optional(),
  tools: z.array(z.string().max(60)).max(10).optional(),
  skills: z.array(z.string().max(128)).max(10).optional(),
});

agentProfilesRouter.put('/personas/:personaId', asyncHandler(async (req, res) => {
  const patch = userPersonaPatchSchema.parse(req.body);
  try {
    res.json(toPersonaView(updateUserPersona(param(req, 'personaId'), patch)));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '编辑失败' });
  }
}));

agentProfilesRouter.delete('/personas/:personaId', asyncHandler(async (req, res) => {
  const personaId = param(req, 'personaId');
  try {
    deleteUserPersona(personaId);
    // 沉淀历史行同步标 dismissed（人设文件是全局的，历史行跨公司全标；失败不阻断删除）
    try {
      getDb().prepare("UPDATE expert_candidate SET status='dismissed', updated_at=? WHERE persona_id=?")
        .run(new Date().toISOString(), personaId);
    } catch { /* 历史标记失败不阻断 */ }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '删除失败' });
  }
}));

/** 从 Persona 库一键克隆为「我的人才」 */
agentProfilesRouter.post('/clone-persona', asyncHandler(async (req, res) => {
  const input = z.object({
    personaId: z.string().min(1),
    displayName: z.string().optional(),
  }).parse(req.body);
  const profile = clonePersonaAsUser(getDb(), input.personaId, input.displayName);
  materializeAgentHome(profile);
  res.status(201).json(profile);
}));

/** 从已有档案克隆为「我的人才」 */
agentProfilesRouter.post('/:id/clone-as-user', asyncHandler(async (req, res) => {
  const input = z.object({
    displayName: z.string().optional(),
  }).optional().parse(req.body);
  const profile = cloneProfileAsUser(getDb(), param(req, 'id'), input?.displayName);
  materializeAgentHome(profile);
  res.status(201).json(profile);
}));

/** 用户手动修改我的人才专属配置（仅限 source === 'user'） */
agentProfilesRouter.patch('/:id/custom-config', asyncHandler(async (req, res) => {
  const input = customConfigSchema.parse(req.body);
  const profile = updateUserCustomConfig(getDb(), param(req, 'id'), input);
  syncAgentIdentityFiles(profile);
  res.json(profile);
}));

agentProfilesRouter.post('/', asyncHandler(async (req, res) => {
  const input = profileSchema.parse(req.body);
  const profile = createAgentProfile(getDb(), input);
  materializeAgentHome(profile);
  res.status(201).json(profile);
}));

agentProfilesRouter.get('/:id', asyncHandler(async (req, res) => {
  res.json(getAgentProfile(getDb(), param(req, 'id')));
}));

agentProfilesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const profile = updateAgentProfile(getDb(), param(req, 'id'), profileSchema.partial().parse(req.body));
  syncAgentIdentityFiles(profile);
  res.json(profile);
}));

agentProfilesRouter.get('/:id/employments', asyncHandler(async (req, res) => {
  const db = getDb();
  res.json(listProfileEmployments(db, param(req, 'id')).map((employment) => ({ ...employment, health: getEmploymentHealth(db, employment.id) })));
}));

agentProfilesRouter.get('/:id/runtime', asyncHandler(async (req, res) => {
  res.json(getEmployeeRuntime(getDb(), param(req, 'id')));
}));

agentProfilesRouter.post('/:id/copy', asyncHandler(async (req, res) => {
  const input = z.object({
    mode: z.enum(['capability-copy', 'snapshot-copy']),
    displayName: z.string().optional(),
  }).parse(req.body);
  const profile = copyAgentProfile(getDb(), param(req, 'id'), input);
  materializeAgentHome(profile);
  syncAgentMemoryFiles(getDb(), profile.id);
  res.status(201).json(profile);
}));

agentProfilesRouter.post('/:id/reset-base', asyncHandler(async (req, res) => {
  const profile = resetAgentProfileToBase(getDb(), param(req, 'id'));
  syncAgentIdentityFiles(profile);
  res.json(profile);
}));

agentProfilesRouter.post('/:id/reset-personal-memory', asyncHandler(async (req, res) => {
  const count = resetPersonalMemory(getDb(), param(req, 'id'), 'user');
  syncAgentMemoryFiles(getDb(), param(req, 'id'));
  res.json({ ok: true, count });
}));

agentProfilesRouter.get('/:id/export-capability', asyncHandler(async (req, res) => {
  res.json(exportCapabilityPackage(getAgentProfile(getDb(), param(req, 'id'))));
}));

companyEmployeesRouter.post('/', asyncHandler(async (req, res) => {
  const input = z.object({
    profileId: z.string().min(1),
    role: z.string().min(1),
    departmentId: z.string().optional(),
    responsibilities: z.string().optional(),
  }).parse(req.body);
  res.status(201).json(recruitAgentProfile(getDb(), { ...input }));
}));

companyEmployeesRouter.post('/recruit', asyncHandler(async (req, res) => {
  const draft = recruitmentDraftSchema.parse(req.body);
  res.status(201).json(recruitFromDraft(getDb(), companyIdOf(req), draft));
}));
