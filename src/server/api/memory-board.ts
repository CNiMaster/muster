/**
 * 记忆看板 API（capability parity 批次 D2，spec 2026-08-25-agent-host-parity-batches）。
 *
 * 定调（拍板）：不做审批队列（沉淀闭环后台自动）；看板=查看/筛选/编辑/删除。
 * 四维筛选：personal=用户偏好（跨员工共享）/workspace=平台/project=项目/craft=人设手艺
 * （personaKey 非空=人设池，空=员工个人手艺）。每条带注入策略徽章（不黑盒）：
 * personal 永远全量 / craft 按穿戴人设 / workspace+project 按任务相关性渐进命中。
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import {
  listMemoryEntries, getMemoryEntry, correctMemoryEntry, deleteMemoryEntry, lockMemoryEntry, unlockMemoryEntry,
  type MemoryScope,
} from '../domain/memory';
import { syncAgentMemoryFiles } from '../domain/agent-home';
import { getMemoryHealth, runMemoryHousekeeping } from '../domain/memory-housekeeping';
import { asyncHandler, param } from './middleware';
import { AppError, ErrorCode } from '../../shared/errors';

export const memoryBoardRouter = Router();

const scopeSchema = z.enum(['personal', 'workspace', 'project', 'craft']);

/** 选择闭环 S4：记忆健康度（膨胀/重复/命中率）+ 手动压实入口（与 30 分钟自动内务同口径）。 */
memoryBoardRouter.get('/health', asyncHandler(async (_req, res) => {
  res.json({ ok: true, health: getMemoryHealth(getDb()) });
}));

memoryBoardRouter.post('/housekeeping', asyncHandler(async (_req, res) => {
  const result = runMemoryHousekeeping(getDb(), { force: true });
  res.json({ ok: true, result, health: getMemoryHealth(getDb()) });
}));

/** 注入策略说明（与 loadContextMemories 行为对齐）。 */
function injectPolicyOf(scope: MemoryScope): { label: string; hint: string } {
  if (scope === 'personal') return { label: '永远全量', hint: '用户稳定偏好，任何任务都带（防「这任务不相关」遗忘）' };
  if (scope === 'craft') return { label: '按人设', hint: '任务穿戴同款人设时注入（人设池全局召回）' };
  if (scope === 'workspace') return { label: '渐进命中', hint: '平台级经验，任务相关时注入（词元+FTS）' };
  return { label: '渐进命中', hint: '项目级经验，本项目相关任务注入（词元+FTS）' };
}

memoryBoardRouter.get('/entries', asyncHandler(async (req, res) => {
  const scope = scopeSchema.optional().parse(req.query.scope);
  const projectId = z.string().optional().parse(req.query.projectId);
  const profileId = z.string().optional().parse(req.query.profileId);
  const personaKey = z.string().optional().parse(req.query.personaKey);
  const q = z.string().optional().parse(req.query.q);
  let entries = listMemoryEntries(getDb(), { ...(scope ? { scope } : {}), ...(projectId ? { projectId } : {}), ...(profileId ? { profileId } : {}) });
  if (personaKey) entries = entries.filter((e) => (e.personaKey ?? null) === (personaKey === '__personal__' ? null : personaKey));
  if (q?.trim()) {
    const lower = q.trim().toLowerCase();
    entries = entries.filter((e) => e.content.toLowerCase().includes(lower));
  }
  const counts: Record<string, number> = { personal: 0, workspace: 0, project: 0, craft: 0 };
  for (const e of listMemoryEntries(getDb(), {})) counts[e.scope] = (counts[e.scope] ?? 0) + 1;
  res.json({
    ok: true,
    entries: entries.slice(0, 300).map((e) => ({
      ...e,
      injectPolicy: injectPolicyOf(e.scope),
    })),
    counts,
  });
}));

memoryBoardRouter.patch('/entries/:entryId', asyncHandler(async (req, res) => {
  const db = getDb();
  const entry = getMemoryEntry(db, param(req, 'entryId'));
  const { content } = z.object({ content: z.string().min(1) }).parse(req.body);
  const updated = correctMemoryEntry(db, entry.id, content, 'user');
  try { syncAgentMemoryFiles(db, entry.profileId); } catch { /* 同步失败不影响看板操作 */ }
  res.json({ ok: true, entry: updated });
}));

memoryBoardRouter.post('/entries/:entryId/:action', asyncHandler(async (req, res) => {
  const db = getDb();
  const entry = getMemoryEntry(db, param(req, 'entryId'));
  const action = z.enum(['lock', 'unlock', 'delete']).parse(param(req, 'action'));
  const updated = action === 'lock' ? lockMemoryEntry(db, entry.id)
    : action === 'unlock' ? unlockMemoryEntry(db, entry.id)
    : deleteMemoryEntry(db, entry.id, 'user');
  try { syncAgentMemoryFiles(db, entry.profileId); } catch { /* 同步失败不影响看板操作 */ }
  res.json({ ok: true, entry: updated });
}));

void AppError; void ErrorCode;
