/**
 * WP3 系统自建专家（免人工确认版）：persona 沉淀管道 集成测试。
 *
 * 验证：
 * - 三类信号 → 【自动入库】（无审批闸）：候选行 status=adopted + persona_id 溯源，人设立即进库可调度。
 * - 去重：同 signal_key 不重复涌现（含已删除的）；草稿名与库内精确同名跳过。
 * - 查/改/删：listExpertCandidates 历史；updateUserPersona 整文件重写（缓存即时可见）；
 *   deleteUserPersona 删文件；deleteSynthesizedPersona 同步标 dismissed。
 * - persona-library 双根：用户根与预置库并存、id 防撞。
 *
 * 注：MUSTER_HOME 必须在动态 import 之前设置（SERVER_CONFIG 在模块加载时读取环境）。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'muster-personas-'));
process.env.MUSTER_HOME = tmpHome;

const { makeTestDb } = await import('./setup');
const { restoreWorkbench } = await import('../../src/server/domain/workbench');
const { createAgent } = await import('../../src/server/domain/agent');
const { createProject } = await import('../../src/server/domain/project');
const { createTask, completeTask } = await import('../../src/server/domain/task');
const { appendTaskEvent } = await import('../../src/server/domain/task-event');
const {
  maybeSynthesizeExpertCandidates,
  listExpertCandidates,
  deleteSynthesizedPersona,
} = await import('../../src/server/domain/expert-synthesis');
const {
  getPersona,
  listPersonas,
  updateUserPersona,
  deleteUserPersona,
  USER_PERSONAS_ROOT,
} = await import('../../src/server/domain/persona-library');

let tdb: ReturnType<typeof makeTestDb>;
let db: import('../../src/server/db/client').DB;
beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});
afterEach(() => {
  tdb.close();
});

function seed() {
  const c = restoreWorkbench(db, { id: 'wb_fix_1', name: '公司' });
  const lead = createAgent(db, { companyId: c.id, name: '干员', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

function completeDirect(projectId: string, assigneeAgentId: string, title: string, inputProtocol: Record<string, unknown> = {}): string {
  const task = createTask(db, { projectId, assigneeAgentId, title, inputProtocol });
  db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
  completeTask(db, task.id, { outcome: 'completed', summary: 'ok', outboundTasks: [], artifacts: [] });
  return task.id;
}

describe('信号 → 自动入库（免确认）', () => {
  it('persona_miss 重复 ≥2 → 立即入库：行 adopted + persona_id，人设 source=user 可检索', async () => {
    const { c, p, lead } = seed();
    const t1 = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '调研合规要求' });
    const t2 = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '梳理合规清单' });
    appendTaskEvent(db, t1.id, 'persona_miss', { requestedPersonaId: 'legal/compliance-officer', beeTitle: '子题A' });
    appendTaskEvent(db, t2.id, 'persona_miss', { requestedPersonaId: 'legal/compliance-officer', beeTitle: '子题B' });

    expect(await maybeSynthesizeExpertCandidates(db, c.id)).toBe(1);
    const history = listExpertCandidates(db, c.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe('adopted');
    expect(history[0]!.personaId).toMatch(/^user\//);
    expect(history[0]!.source).toBe('persona_miss');
    // 免确认：人设立即在库（养蜂人索引即可见）
    const persona = getPersona(history[0]!.personaId!);
    expect(persona).not.toBeNull();
    expect(persona!.source).toBe('user');
    expect(persona!.soul.length).toBeGreaterThan(0);

    // 同 signal_key 不重复涌现（任意状态都算已处理）
    expect(await maybeSynthesizeExpertCandidates(db, c.id)).toBe(0);
    expect(listExpertCandidates(db, c.id)).toHaveLength(1);
  });

  it('匿名蜂同 goal 完成 ≥3 且零失败 → 自动入库', async () => {
    const { c, p } = seed();
    const bee = createAgent(db, { companyId: c.id, name: '工蜂-1', role: 'swarm-worker', hidden: true });
    for (let i = 0; i < 3; i++) {
      completeDirect(p.id, bee.id, `定价维度${i}`, { trigger: 'swarm_bee', swarm: { goal: '竞品定价调研XYZ', brief: 'x' }, swarmNode: true });
    }
    expect(await maybeSynthesizeExpertCandidates(db, c.id)).toBeGreaterThanOrEqual(1);
    const sources = listExpertCandidates(db, c.id).map((x) => x.source);
    expect(sources).toContain('bee_record');
    for (const row of listExpertCandidates(db, c.id)) {
      expect(getPersona(row.personaId!)).not.toBeNull();
    }
  });

  it('普通员工同类任务 ≥3 零返工 → 自动入库；库内同名草稿跳过', async () => {
    const { c, p, lead } = seed();
    for (let i = 0; i < 3; i++) {
      completeDirect(p.id, lead.id, '撰写季度经营分析Q1');
    }
    expect(await maybeSynthesizeExpertCandidates(db, c.id)).toBeGreaterThanOrEqual(1);
    expect(listExpertCandidates(db, c.id).some((x) => x.source === 'generalist_record')).toBe(true);

    // 同名终止：手工造一个与 fallback 草稿同名的用户人设 → 同型新信号不重复写文件，
    // 但落一行 adopted 溯源（signal_key 终止，不再每 tick 重付 LLM 起草）。
    // 公司退役批次D：agent 归属已是单例工作台（本项目、原 c2 的跨公司场景坍缩），
    // 故在同一个工作台下另建项目 + 员工模拟第二组信号（firstAgentId 不属于本测试关注点，不设）。
    const lead2 = createAgent(db, { name: '干员2', role: 'lead' });
    const p2 = createProject(db, { companyId: c.id, name: '项目2', rootDir: '/tmp/p2', initialState: 'active' });
    mkdirSync(path.join(USER_PERSONAS_ROOT, 'specialized'), { recursive: true });
    writeFileSync(path.join(USER_PERSONAS_ROOT, 'specialized', 'quarterly-report.md'), [
      '---', 'name: 撰写季度经营分析Q2专家', 'description: 测试同名', '---',
      '', '## 你的身份与记忆', '', 'x', '', '## 核心使命', '', 'y', '', '## 关键规则', '', '- r',
    ].join('\n'), 'utf8');
    for (let i = 0; i < 3; i++) {
      completeDirect(p2.id, lead2.id, '撰写季度经营分析Q2');
    }
    expect(await maybeSynthesizeExpertCandidates(db, c.id)).toBe(0); // 未新写文件
    const rows = listExpertCandidates(db, c.id);
    const q2Row = rows.find((x) => x.personaId === 'user/specialized/quarterly-report');
    expect(q2Row).toBeDefined();
    expect(q2Row!.status).toBe('adopted'); // 自建同名 = 信号已消化（补录溯源）
    // signal_key 已落：后续 tick 不再处理
    expect(await maybeSynthesizeExpertCandidates(db, c.id)).toBe(0);
    expect(listExpertCandidates(db, c.id).filter((x) => x.personaId === 'user/specialized/quarterly-report')).toHaveLength(1);
    // 库内同名人设只有手工那一个（未重复写文件）
    expect(listPersonas().filter((p) => p.name === '撰写季度经营分析Q2专家')).toHaveLength(1);
  });
});

describe('查/改/删', () => {
  it('updateUserPersona：整文件重写 + 缓存即时可见；预置库不可改', async () => {
    const { c, p, lead } = seed();
    const t1 = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '画品牌插画' });
    appendTaskEvent(db, t1.id, 'persona_miss', { requestedPersonaId: 'visual/brand-illustrator', beeTitle: '插画' });
    appendTaskEvent(db, t1.id, 'persona_miss', { requestedPersonaId: 'visual/brand-illustrator', beeTitle: '插画2' });
    await maybeSynthesizeExpertCandidates(db, c.id);
    const candidate = listExpertCandidates(db, c.id)[0]!;
    const personaId = candidate.personaId!;

    const updated = updateUserPersona(personaId, {
      name: '品牌插画专家',
      description: '何时使用：画品牌视觉/插画任务',
      tools: ['image_generate', 'playwright'],
    });
    expect(updated.name).toBe('品牌插画专家');
    expect(updated.tools).toEqual(['image_generate', 'playwright']);
    // id/文件不变，重读可见（缓存强刷）
    expect(getPersona(personaId)!.name).toBe('品牌插画专家');
    expect(existsSync(path.join(USER_PERSONAS_ROOT, `${personaId.slice('user/'.length)}.md`))).toBe(true);

    // 预置库只读
    expect(() => updateUserPersona('product/product-manager', { name: 'x' })).toThrow();
  });

  it('deleteSynthesizedPersona：删文件 + 历史标 dismissed；再跑同信号不复活', async () => {
    const { c, p, lead } = seed();
    const t1 = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: '整理竞品矩阵ABC' });
    appendTaskEvent(db, t1.id, 'persona_miss', { requestedPersonaId: 'product/competitor-matrix', beeTitle: '矩阵' });
    appendTaskEvent(db, t1.id, 'persona_miss', { requestedPersonaId: 'product/competitor-matrix', beeTitle: '矩阵2' });
    await maybeSynthesizeExpertCandidates(db, c.id);
    const candidate = listExpertCandidates(db, c.id)[0]!;
    const personaId = candidate.personaId!;
    expect(getPersona(personaId)).not.toBeNull();

    deleteSynthesizedPersona(db, personaId, c.id);
    expect(getPersona(personaId)).toBeNull();
    expect(existsSync(path.join(USER_PERSONAS_ROOT, `${personaId.slice('user/'.length)}.md`))).toBe(false);
    expect(listExpertCandidates(db, c.id)[0]!.status).toBe('dismissed');

    // 已删除的信号不再涌现（历史行存在即视为已处理）
    expect(await maybeSynthesizeExpertCandidates(db, c.id)).toBe(0);

    // 预置库不可删
    expect(() => deleteUserPersona('product/product-manager')).toThrow();
  });
});

describe('双根扫描', () => {
  it('用户根与预置库并存：id 前缀防撞、索引可见', () => {
    mkdirSync(path.join(USER_PERSONAS_ROOT, 'marketing'), { recursive: true });
    writeFileSync(path.join(USER_PERSONAS_ROOT, 'marketing', 'my-custom-expert.md'), [
      '---',
      'name: 我的自定义专家',
      'description: 测试写入的用户人设',
      '---',
      '',
      '## 你的身份与记忆',
      '',
      '自定义身份正文。',
      '',
      '## 核心使命',
      '',
      '把用户根人设接入库。',
      '',
      '## 关键规则',
      '',
      '- 规则一',
    ].join('\n'), 'utf8');

    const persona = getPersona('user/marketing/my-custom-expert');
    expect(persona).not.toBeNull();
    expect(persona!.name).toBe('我的自定义专家');
    expect(persona!.source).toBe('user');
    expect(getPersona('product/product-manager')).not.toBeNull();
    expect(listPersonas().some((x) => x.id === 'user/marketing/my-custom-expert')).toBe(true);
  });
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});
