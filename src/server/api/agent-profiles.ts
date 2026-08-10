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
  copyAgentProfile,
  resetAgentProfileToBase,
} from '../domain/agent-profile';
import { asyncHandler, param } from './middleware';
import { exportCapabilityPackage, materializeAgentHome, syncAgentIdentityFiles, syncAgentMemoryFiles } from '../domain/agent-home';
import { resetPersonalMemory } from '../domain/memory';
import { recruitFromDraft } from '../domain/recruitment';
import { getEmployeeRuntime } from '../domain/employee-runtime';
import { getEmploymentHealth } from '../domain/executor-health';
import { listPersonas, getPersona, listPersonaDomains, searchPersonas } from '../domain/persona-library';

export const agentProfilesRouter = Router();
export const companyEmployeesRouter = Router({ mergeParams: true });

const recruitmentDraftSchema = z.object({
  source: z.enum(['reuse-profile', 'new-profile', 'role-template']),
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
  /** 阶段三任务 3.1：从 personas 专家库自动填充（用户显式字段覆盖）。 */
  personaId: z.string().optional(),
});

agentProfilesRouter.get('/', asyncHandler(async (_req, res) => {
  const db = getDb();
  const profiles = listAgentProfiles(db);
  // 附带每个档案的在营公司任职数（避免前端 N+1）。
  const countRows = db.prepare(
    `SELECT profile_id, COUNT(*) as n FROM company_employee GROUP BY profile_id`,
  ).all() as Array<{ profile_id: string; n: number }>;
  const countMap = new Map(countRows.map((r) => [r.profile_id, r.n]));
  res.json(profiles.map((p) => ({ ...p, employmentCount: countMap.get(p.id) ?? 0 })));
}));

// ===== Persona 专家库（阶段三任务 3.1） =====

agentProfilesRouter.get('/personas/domains', asyncHandler(async (_req, res) => {
  res.json(listPersonaDomains());
}));

/** 列表/搜索：?domain=marketing&q=关键词 */
agentProfilesRouter.get('/personas', asyncHandler(async (req, res) => {
  const domain = typeof req.query.domain === 'string' && req.query.domain ? req.query.domain : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const result = q ? searchPersonas(q) : listPersonas(domain);
  res.json(result);
}));

agentProfilesRouter.get('/personas/:personaId', asyncHandler(async (req, res) => {
  const persona = getPersona(param(req, 'personaId'));
  if (!persona) {
    res.status(404).json({ error: '专家不存在' });
    return;
  }
  res.json(persona);
}));

agentProfilesRouter.post('/', asyncHandler(async (req, res) => {
  const input = profileSchema.parse(req.body);
  // personaId 由 createAgentProfile 内部自动填充 soul/principles/capabilities
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
  res.status(201).json(recruitAgentProfile(getDb(), { companyId: param(req, 'companyId'), ...input }));
}));

companyEmployeesRouter.post('/recruit', asyncHandler(async (req, res) => {
  const draft = recruitmentDraftSchema.parse(req.body);
  res.status(201).json(recruitFromDraft(getDb(), param(req, 'companyId'), draft));
}));
