/**
 * 讨论室 REST API。
 *
 * 挂载在 /api/projects/:projectId/discussions 下。
 * - GET /：列出项目的讨论室（默认进行中，?state=all 全部含归档）
 * - GET /:id：讨论详情（含参与者 + 发言流 + 纪要）
 * - POST /：用户主动发起探讨（蓝图组织批次4：brainstorm 场景，参与者排除一次性执行体）
 * - POST /:id/close：手动关闭讨论
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { asyncHandler, param } from './middleware';
import { listDiscussions, getDiscussion, listParticipants, listTurns, closeDiscussion, startUserDiscussion } from '../domain/discussion';
import { getAgent } from '../domain/agent';

export const discussionsRouter = Router();

/** 讨论列表（轻量，不含发言流）。 */
discussionsRouter.get('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const projectId = param(req, 'projectId');
  const state = (req.query.state as string) === 'all' ? undefined : (req.query.state as 'open' | 'concluding' | 'concluded' | 'closed' | undefined);
  const discussions = listDiscussions(db, projectId, state);
  // 附带参与者名字（轻量摘要）
  const result = discussions.map((d) => {
    const participants = listParticipants(db, d.id).map((p) => {
      try { return { agentId: p.agentId, name: getAgent(db, p.agentId).name, role: p.role }; } catch { return { agentId: p.agentId, name: '(已离职)', role: p.role }; }
    });
    return {
      id: d.id, topic: d.topic, state: d.state, scenario: d.context.scenario,
      turnCount: d.turnCount, maxTurns: d.maxTurns,
      currentSpeakerAgentId: d.currentSpeakerAgentId,
      minutes: d.minutes, initiatorAgentId: d.initiatorAgentId,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
      participants,
    };
  });
  res.json(result);
}));

/** 讨论详情（含完整发言流）。 */
discussionsRouter.get('/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  const id = param(req, 'id');
  const disc = getDiscussion(db, id);
  const participants = listParticipants(db, id).map((p) => {
    try { return { agentId: p.agentId, name: getAgent(db, p.agentId).name, role: p.role, turnIndex: p.turnIndex }; } catch { return { agentId: p.agentId, name: '(已离职)', role: p.role, turnIndex: p.turnIndex }; }
  });
  const turns = listTurns(db, id).map((t) => {
    let speakerName = '(未知)';
    try { speakerName = getAgent(db, t.speakerAgentId).name; } catch { /* */ }
    return { ...t, speakerName };
  });
  res.json({ ...disc, participants, turns });
}));

/** 用户主动发起探讨（蓝图组织批次4）。 */
discussionsRouter.post('/', asyncHandler(async (req, res) => {
  const input = z.object({
    topic: z.string().min(1).max(200),
    participantAgentIds: z.array(z.string().min(1)).min(2).max(8),
    context: z.record(z.unknown()).optional(),
    maxTurns: z.number().int().min(1).max(24).optional(),
  }).parse(req.body);
  const result = startUserDiscussion(getDb(), { projectId: param(req, 'projectId'), ...input });
  res.status(201).json({ discussionId: result.discussion.id, turnTaskId: result.turnTaskId });
}));

/** 手动关闭讨论。 */
discussionsRouter.post('/:id/close', asyncHandler(async (req, res) => {
  const db = getDb();
  const id = param(req, 'id');
  const disc = closeDiscussion(db, id);
  res.json({ ok: true, state: disc.state });
}));
