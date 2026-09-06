/**
 * 蓝图 AI 语义路由（2026-08-28 定案：词法命中从读侧退役）。
 * - routeBlueprintByAI：mock callLlm——命中/none/低置信/失败/非法输出/未知 id/空库 全路径
 * - routeAndBackfill：queued 回填穿戴+事件；已开跑放弃；已有穿戴不重复调用
 * - evolveBlueprintById：按 id 直记（执行穿的=记账的，标题换词不漂移）
 */
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';
import { createTask, getTask, completeTask } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { enqueueReflection, drainReflectionQueue } from '../../src/server/domain/reflection';
import { evolveBlueprint, getBlueprint, listBlueprints } from '../../src/server/domain/blueprint';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { routeBlueprintByAI, routeAndBackfill, shuffleCandidates } from '../../src/server/domain/capability-routing';
import { ensureBlueprintPresets } from '../../src/server/domain/blueprint-presets';
import { listPersonas } from '../../src/server/domain/persona-library';

let db: DB;
const mockLlmResult = (content: string) => ({ content, model: 'mock', usage: { promptTokens: 1, completionTokens: 1 } });

beforeEach(() => {
  db = makeTestDb().db;
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function seed(): { workbenchId: string; projectId: string; leadId: string } {
  const workbench = restoreWorkbench(db, { id: 'wb_route', name: '工作台' });
  const project = createProject(db, { companyId: workbench.id, name: '路由项目', initialState: 'active' });
  const lead = createAgent(db, { companyId: workbench.id, name: '负责人', role: 'lead', canDispatch: true });
  ensurePrimaryThread(db, project.id, lead.id);
  return { workbenchId: workbench.id, projectId: project.id, leadId: lead.id };
}

describe('routeBlueprintByAI', () => {
  it('LLM 返回候选 id 且置信达标 → 命中', async () => {
    const { projectId } = seed();
    ensureBlueprintPresets(db);
    const novel = db.prepare("SELECT id FROM blueprint WHERE label='长篇小说创作'").get() as { id: string };
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult(`{"blueprintId":"${novel.id}","confidence":0.9,"reason":"写小说属于长篇创作"}`),
    );
    const route = await routeBlueprintByAI(db, { taskTitle: '写一章重逢的剧情' });
    expect(route.blueprintId).toBe(novel.id);
    expect(route.confidence).toBe(0.9);
  });

  it('LLM 返回 none / 置信低于 0.6 / 抛错 / 非法 JSON / 未知 id → 一律无蓝图（fail-open）', async () => {
    const { projectId } = seed();
    ensureBlueprintPresets(db);
    const some = (db.prepare("SELECT id FROM blueprint LIMIT 1").get() as { id: string }).id;

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult('{"blueprintId":"none","confidence":0.9,"reason":"不搭边"}'),
    );
    expect((await routeBlueprintByAI(db, { taskTitle: '随便什么活' })).blueprintId).toBeNull();

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult(`{"blueprintId":"${some}","confidence":0.3,"reason":"拿不准"}`),
    );
    const low = await routeBlueprintByAI(db, { taskTitle: '随便什么活' });
    expect(low.blueprintId).toBeNull();
    expect(low.reason).toContain('置信不足');

    vi.spyOn(llmCallModule, 'callLlm').mockRejectedValue(new Error('no credential'));
    const failed = await routeBlueprintByAI(db, { taskTitle: '随便什么活' });
    expect(failed.blueprintId).toBeNull();
    expect(failed.reason).toContain('不可用');

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult('这不是 JSON'));
    expect((await routeBlueprintByAI(db, { taskTitle: '随便什么活' })).blueprintId).toBeNull();

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult('{"blueprintId":"bp_fabricated","confidence":0.99,"reason":"编的"}'),
    );
    const unknown = await routeBlueprintByAI(db, { taskTitle: '随便什么活' });
    expect(unknown.blueprintId).toBeNull();
    expect(unknown.reason).toContain('候选之外');
    void projectId;
  });

  it('空蓝图库 → 无蓝图且不调用 LLM', async () => {
    seed();
    const spy = vi.spyOn(llmCallModule, 'callLlm');
    const route = await routeBlueprintByAI(db, { taskTitle: '任何活' });
    expect(route.blueprintId).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('routeAndBackfill（直达路径后台自动配）', () => {
  it('queued 任务回填穿戴主槽人设+留事件；不改 assignee', async () => {
    const { projectId, leadId } = seed();
    ensureBlueprintPresets(db);
    const novel = db.prepare("SELECT id FROM blueprint WHERE label='长篇小说创作'").get() as { id: string };
    const task = createTask(db, { projectId, assigneeAgentId: leadId, title: '写小说正文章节' });
    expect(task.personaId).toBeNull();

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult(`{"blueprintId":"${novel.id}","confidence":0.85,"reason":"创作类"}`),
    );
    await routeAndBackfill(db, task.id);

    const after = getTask(db, task.id);
    expect(after.personaId).toBe('novel/novel-writer');
    const proto = after.inputProtocol as Record<string, unknown>;
    expect(proto.blueprintMatched).toBe(novel.id);
    expect(proto.blueprintRoutedBy).toBe('ai');
    expect(proto.staffingMode).toBe('official_benchmark');
    expect(after.assigneeAgentId).toBe(leadId); // 不换人
    const events = listTaskEvents(db, task.id).filter((e) => e.kind === 'blueprint_routed');
    expect(events).toHaveLength(1);
  });

  it('LLM 判 none → 跳过事件落痕；任务已开跑 → 放弃回填', async () => {
    const { projectId } = seed();
    ensureBlueprintPresets(db);
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult('{"blueprintId":"none","confidence":0.8,"reason":"没有匹配"}'),
    );
    const t1 = createTask(db, { projectId, title: '未知领域的活' });
    await routeAndBackfill(db, t1.id);
    expect(getTask(db, t1.id).personaId).toBeNull();
    expect(listTaskEvents(db, t1.id).some((e) => e.kind === 'blueprint_route_skipped')).toBe(true);

    // 已开跑（模拟：直接置为 running）→ 回填放弃
    const t2 = createTask(db, { projectId, title: '写小说正文章节' });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(t2.id);
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult('{"blueprintId":"bp_x","confidence":0.99,"reason":"高置信"}'),
    );
    const candidates = db.prepare("SELECT id FROM blueprint WHERE label='长篇小说创作'").get() as { id: string };
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult(`{"blueprintId":"${candidates.id}","confidence":0.99,"reason":"创作类"}`),
    );
    await routeAndBackfill(db, t2.id);
    expect(getTask(db, t2.id).personaId).toBeNull();
    expect(listTaskEvents(db, t2.id).some((e) => e.kind === 'blueprint_route_skipped' && String((e.payload as Record<string, unknown>).reason).includes('放弃'))).toBe(true);
  });

  it('已有穿戴/已路由过的任务不再调用 AI（幂等）', async () => {
    const { projectId, leadId } = seed();
    ensureBlueprintPresets(db);
    const personas = listPersonas();
    const t = createTask(db, { projectId, assigneeAgentId: leadId, title: '有显式人设的任务', personaId: personas[0]!.id });
    const spy = vi.spyOn(llmCallModule, 'callLlm');
    await routeAndBackfill(db, t.id);
    expect(spy).not.toHaveBeenCalled();
  });

  it('复审修复：显式注入技能/能力/知识的任务不回填（与 createTask 穿戴块同规则）', async () => {
    const { projectId } = seed();
    ensureBlueprintPresets(db);
    const spy = vi.spyOn(llmCallModule, 'callLlm');
    const t1 = createTask(db, { projectId, title: '写小说正文章节', requiredSkillIds: ['source-driven-development'] });
    await routeAndBackfill(db, t1.id);
    const t2 = createTask(db, { projectId, title: '写小说正文章节', requiredCapabilityIds: ['cap_1'] });
    await routeAndBackfill(db, t2.id);
    const t3 = createTask(db, { projectId, title: '写小说正文章节', knowledgeTargets: ['kb_1'] });
    await routeAndBackfill(db, t3.id);
    expect(spy).not.toHaveBeenCalled();
    expect(getTask(db, t1.id).personaId).toBeNull();
    expect(getTask(db, t2.id).personaId).toBeNull();
    expect(getTask(db, t3.id).personaId).toBeNull();
  });

  it('复审修复：LLM 窗口内 protocol 被改 → 回填合并到最新版不覆盖新键', async () => {
    const { projectId } = seed();
    ensureBlueprintPresets(db);
    const novel = db.prepare("SELECT id FROM blueprint WHERE label='长篇小说创作'").get() as { id: string };
    const t = createTask(db, { projectId, title: '写小说正文章节' });
    // 模拟：创建后 gate 确认写入了新键，回填在 LLM 返回后必须基于最新 protocol 合并
    db.prepare('UPDATE task SET input_protocol_json=? WHERE id=?').run(
      JSON.stringify({ goal: '用户后补的目标', staffingMode: 'unrouted' }), t.id,
    );
    vi.spyOn(llmCallModule, 'callLlm').mockImplementation(async () => {
      // LLM 在途时另一路径写入紧急标记
      db.prepare('UPDATE task SET input_protocol_json=? WHERE id=?').run(
        JSON.stringify({ goal: '用户后补的目标', staffingMode: 'unrouted', urgentNote: '在途写入' }), t.id,
      );
      return mockLlmResult(`{"blueprintId":"${novel.id}","confidence":0.9,"reason":"创作类"}`);
    });
    await routeAndBackfill(db, t.id);
    const proto = getTask(db, t.id).inputProtocol as Record<string, unknown>;
    expect(proto.blueprintMatched).toBe(novel.id);
    expect(proto.urgentNote).toBe('在途写入'); // 窗口内写入的键不丢
    expect(proto.goal).toBe('用户后补的目标');
  });
});

describe('路由去偏与无信号守卫（2026-09-06 复审：空白任务被穿上小说蓝图的根因）', () => {
  it('洗牌纯函数：同标题顺序稳定、是全量排列、不同标题顺序不同', () => {
    const items = Array.from({ length: 26 }, (_, i) => ({ id: `bp_${i}` }));
    const a1 = shuffleCandidates(items, '写一章重逢的剧情');
    const a2 = shuffleCandidates(items, '写一章重逢的剧情');
    const b = shuffleCandidates(items, '整理会议纪要');
    expect(a1).toEqual(a2);
    expect([...a1].map((x) => x.id).sort()).toEqual(items.map((x) => x.id).sort());
    expect(a1.map((x) => x.id)).not.toEqual(b.map((x) => x.id));
  });

  it('同一标题两次路由：传给 LLM 的候选清单完全一致（可复现）且全候选在场', async () => {
    const { projectId } = seed();
    ensureBlueprintPresets(db);
    const calls: string[] = [];
    vi.spyOn(llmCallModule, 'callLlm').mockImplementation(async (_db, input) => {
      calls.push(input.user);
      return mockLlmResult('{"blueprintId":"none","confidence":1,"reason":"无匹配"}');
    });
    await routeBlueprintByAI(db, { taskTitle: '写一章重逢的剧情' });
    await routeBlueprintByAI(db, { taskTitle: '写一章重逢的剧情' });
    expect(calls[0]).toBe(calls[1]);
    expect((calls[0]!.match(/^- /gm) ?? []).length).toBe(26);
  });

  it('空白任务不路由：无标题无目标 → 直接放弃并留事件（不调 LLM）', async () => {
    const { projectId, leadId } = seed();
    ensureBlueprintPresets(db);
    const spy = vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult(`{"blueprintId":"whatever","confidence":0.99,"reason":"瞎猜"}`),
    );
    // createTask 本身拦空标题（载体创建校验）——先建真任务再模拟存量/异常空白标题
    const blank = createTask(db, { projectId, assigneeAgentId: leadId, title: 'x' });
    db.prepare("UPDATE task SET title=' ' WHERE id=?").run(blank.id);
    await routeAndBackfill(db, blank.id);
    expect(getTask(db, blank.id).personaId).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    const skipped = listTaskEvents(db, blank.id).filter((e) => e.kind === 'blueprint_route_skipped');
    expect(skipped).toHaveLength(1);
    expect((skipped[0]!.payload as Record<string, unknown>).reason).toContain('空白任务');

    // 有目标（goal）补信号时照常路由：1 字符标题 + goal 在场 → 走 LLM
    const withGoal = createTask(db, { projectId, assigneeAgentId: leadId, title: 'R' });
    db.prepare("UPDATE task SET input_protocol_json=? WHERE id=?").run(JSON.stringify({ goal: '把小说第一章写出来' }), withGoal.id);
    await routeAndBackfill(db, withGoal.id);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('evolveBlueprintById（记账分叉）', () => {
  it('按 id 直记：标题换词也记到原蓝图（执行穿的=记账的）', async () => {
    const { projectId } = seed();
    ensureBlueprintPresets(db);
    const novel = db.prepare("SELECT id FROM blueprint WHERE label='长篇小说创作'").get() as { id: string };
    const before = getBlueprint(db, novel.id);
    const outsider = listPersonas().find((p) => !before.staffing.some((s) => s.personaId === p.id))!;

    const result = (await import('../../src/server/domain/blueprint')).evolveBlueprintById(db, {
      blueprintId: novel.id,
      projectId,
      personaId: outsider.id,
      personaName: outsider.name,
      win: true,
      tools: [{ id: 'edit_file', kind: 'tool' }],
    })!;
    expect(result.id).toBe(novel.id);
    expect(result.wins).toBe(1);
    expect(result.staffing).toHaveLength(6); // 小说预制已满 6 槽：上限行为，不再扩员
    expect(result.tools.some((t) => t.id === 'edit_file')).toBe(true);

    // 3 槽蓝图（视频制作）验证扩员路径
    const video = db.prepare("SELECT id FROM blueprint WHERE label='视频制作'").get() as { id: string };
    const expanded = (await import('../../src/server/domain/blueprint')).evolveBlueprintById(db, {
      blueprintId: video.id,
      projectId,
      personaId: outsider.id,
      personaName: outsider.name,
      win: true,
    })!;
    expect(expanded.staffing.some((s) => s.personaId === outsider.id)).toBe(true);
  });

  it('端到端：显式穿戴的任务终态后 byId 记账（聚类路径不产生平行蓝图）', async () => {
    const { projectId, leadId, workbenchId } = seed();
    ensureBlueprintPresets(db);
    const novel = db.prepare("SELECT id FROM blueprint WHERE label='长篇小说创作'").get() as { id: string };
    const task = createTask(db, { projectId, assigneeAgentId: leadId, title: '完全不相干的标题措辞_xyz', blueprintId: novel.id });
    expect(task.personaId).toBe('novel/novel-writer');
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    const completed = completeTask(db, task.id, { outcome: 'completed', summary: '完成', outboundTasks: [], artifacts: [] });
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult('SKIPPED'));
    enqueueReflection(db, { task: getTask(db, task.id), outcome: 'completed', signal: 'completed' });
    await drainReflectionQueue(db, { maxPerTick: 5 });

    // 记账进原蓝图（而非按标题聚出新蓝图）
    expect(getBlueprint(db, novel.id).wins).toBe(1);
    expect(listBlueprints(db, workbenchId).filter((bp) => bp.id !== novel.id && bp.source === 'evolved')).toHaveLength(0);
  });
});
