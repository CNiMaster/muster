/**
 * 优化对话结构提案的解析门（2026-08-29 批次③）：mock LLM 返回，验证
 * - 合法 adjust_staffing / update_stages 提案被解析入库（params 规范化）
 * - 载荷不合法的结构提案在入库前被丢弃（fail-closed，不落数据库）
 * - reply（含代码围栏）正常剥离入库
 * 用户意图驱动的定调：结构编辑只在用户明说时给（本测只验管线，不验 LLM 智商）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb, createNovelCompany } from '../integration/setup';

vi.mock('../../src/server/domain/llm-call', () => ({ callLlm: vi.fn() }));
import { callLlm } from '../../src/server/domain/llm-call';
const callLlmMock = callLlm as unknown as ReturnType<typeof vi.fn>;

import { createProject } from '../../src/server/domain/project';
import { evolveBlueprint } from '../../src/server/domain/blueprint';
import { sendOptimizeChatMessage } from '../../src/server/domain/blueprint-optimize-chat';
import { listOptimizationItems } from '../../src/server/domain/blueprint-optimizer';
import { listPersonas } from '../../src/server/domain/persona-library';

let db: DB;
let companyId: string;
let projectId: string;
let blueprintId: string;

beforeEach(() => {
  callLlmMock.mockReset();
  const tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  companyId = r.company.id;
  const project = createProject(db, { companyId, name: 'p', rootDir: '/tmp/boc', firstAgentId: r.agents.lead.id, initialState: 'active' });
  projectId = project.id;
  const bp = evolveBlueprint(db, { companyId, projectId, taskTitle: '一轮结构编辑测试_xyz', personaId: 'p_writer', personaName: '笔杆子', win: true })!;
  blueprintId = bp.id;
});

function mockLlmJson(payload: unknown): void {
  callLlmMock.mockResolvedValueOnce({ content: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` });
}

describe('优化对话结构提案解析', () => {
  it('合法结构提案：adjust_staffing 与 update_stages 落 pending，params 规范化保留', async () => {
    const [p1, p2] = listPersonas();
    mockLlmJson({
      reply: '按你的要求：换两位成员，并把流程拆成两步。',
      proposals: [
        {
          actionType: 'adjust_staffing',
          reason: '用户要求换人',
          expectedEffect: '班底更合适',
          params: { staffing: [{ personaId: p1.id, personaName: p1.name, role: '主责' }, { personaId: p2.id, personaName: p2.name }] },
        },
        {
          actionType: 'update_stages',
          reason: '用户要求拆两步',
          expectedEffect: '先梳理后成稿',
          params: { stages: [
            { id: 's1', step: 1, label: '梳理', description: '对齐目标' },
            { id: 's2', step: 2, label: '成稿', staffingPersonaIds: ['p_writer'] },
          ] },
        },
      ],
    });

    const turn = await sendOptimizeChatMessage(db, companyId, blueprintId, '帮我把班底换成更合适的人，流程拆成两步');
    expect(turn.source).toBe('llm');
    expect(turn.messages).toHaveLength(2);
    const assistant = turn.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('按你的要求：换两位成员，并把流程拆成两步。');

    const pending = listOptimizationItems(db, companyId, blueprintId).filter((i) => i.status === 'pending');
    const staffing = pending.find((i) => i.actionType === 'adjust_staffing')!;
    expect(staffing.params.staffing).toHaveLength(2);
    expect(staffing.params.staffing[0]).toMatchObject({ personaId: p1.id, role: '主责' });
    const stages = pending.find((i) => i.actionType === 'update_stages')!;
    expect(stages.params.stages).toHaveLength(2);
    expect(stages.params.stages[1]).toMatchObject({ staffingPersonaIds: ['p_writer'] });
  });

  it('载荷不合法的结构提案整条丢弃（不落数据库），reply 照常入库', async () => {
    mockLlmJson({
      reply: '这些结构修改的载荷不完整，我没有入库，请在下方看我说明。',
      proposals: [
        { actionType: 'adjust_staffing', reason: '缺字段', expectedEffect: 'x', params: { staffing: [{ personaName: '只有名字' }] } },
        { actionType: 'adjust_staffing', reason: '空班底', expectedEffect: 'x', params: { staffing: [] } },
        { actionType: 'update_stages', reason: '阶段缺 label', expectedEffect: 'x', params: { stages: [{ id: 's1', step: 1 }] } },
        { actionType: 'update_stages', reason: '空阶段', expectedEffect: 'x', params: { stages: [] } },
        { actionType: 'hack_shell', reason: '未知动作', expectedEffect: 'x', params: {} },
      ],
    });

    const turn = await sendOptimizeChatMessage(db, companyId, blueprintId, '随便改改');
    expect(turn.source).toBe('llm');
    expect(turn.newProposals).toHaveLength(0);
    expect(listOptimizationItems(db, companyId, blueprintId).filter((i) => i.status === 'pending')).toHaveLength(0);
    const assistant = turn.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toContain('载荷不完整');
  });

  it('rename_blueprint：合法 label 入库；空/超长被丢', async () => {
    mockLlmJson({
      reply: '名字确实不直观，改名。',
      proposals: [
        { actionType: 'rename_blueprint', reason: '拼名难懂', expectedEffect: '直观', params: { label: '行业调研报告' } },
        { actionType: 'rename_blueprint', reason: '空 label', expectedEffect: 'x', params: { label: '  ' } },
        { actionType: 'rename_blueprint', reason: '超长', expectedEffect: 'x', params: { label: 'y'.repeat(41) } },
      ],
    });
    const turn = await sendOptimizeChatMessage(db, companyId, blueprintId, '这名字太怪了，改个直观的');
    expect(turn.newProposals).toHaveLength(1);
    expect(turn.newProposals[0]!.params).toEqual({ label: '行业调研报告' });
  });

  it('治理类提案不受影响：polish_description 照旧解析', async () => {
    mockLlmJson({
      reply: '好的，先润色描述。',
      proposals: [{ actionType: 'polish_description', reason: '描述过时', expectedEffect: '更清楚', params: { description: '用于「一轮结构编辑测试」这类活的打法。' } }],
    });
    const turn = await sendOptimizeChatMessage(db, companyId, blueprintId, '把描述改清楚点');
    expect(turn.newProposals.map((i) => i.actionType)).toEqual(['polish_description']);
  });
});
