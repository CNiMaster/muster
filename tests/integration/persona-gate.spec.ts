/**
 * B4 专家配枪门禁 集成测试。
 *
 * 验证：
 * - 门禁兜底：入库人设必须带 tools——无 tools 草稿注入默认套装（调度匹配有据）。
 * - LLM 草稿自带 tools → 保持原样不覆盖。
 * - writeUserPersonaFile 产出的文件可被 persona-library 解析回 tools。
 * - completeTask 落 chain_stats 单事件（breadthTier/toolChainCount/reworkCount）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, completeTask } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { writeUserPersonaFile, type DraftCard } from '../../src/server/domain/expert-synthesis';
import { getPersona, listPersonas } from '../../src/server/domain/persona-library';
import { DEFAULT_TOOL_KIT } from '../../src/server/domain/tool-chain';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

function seed() {
  const c = restoreWorkbench(db, { id: 'wb_gate_1', name: '公司' });
  const lead = createAgent(db, { companyId: c.id, name: '干员', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: '项目', rootDir: '/tmp/gate', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

const BARE_DRAFT: DraftCard = {
  name: '裸奔专家',
  domain: 'specialized',
  description: '何时使用：无 tools 草稿',
  soul: '身份',
  principles: ['规则一'],
  tools: [],
};

const ARMED_DRAFT: DraftCard = {
  name: '武装专家',
  domain: 'specialized',
  description: '何时使用：自带武器',
  soul: '身份',
  principles: ['规则一'],
  tools: ['WebFetch', 'websearch'],
};

describe('专家配枪门禁', () => {
  it('无 tools 草稿注入默认套装入库；自带 tools 保持原样；文件可解析回 tools', () => {
    seed();
    // 门禁后的裸草稿（tools=[] → 注入 DEFAULT_TOOL_KIT）
    const { personaId } = writeUserPersonaFile({ ...BARE_DRAFT, tools: [...DEFAULT_TOOL_KIT] });
    const parsed = getPersona(personaId);
    expect(parsed).not.toBeNull();
    expect(parsed!.tools.length).toBeGreaterThan(0);
    expect(parsed!.tools).toContain('read');
    expect(parsed!.tools).toContain('webfetch');
    // 自带武器不覆盖
    const { personaId: armedId } = writeUserPersonaFile(ARMED_DRAFT);
    const armed = getPersona(armedId)!;
    expect(armed.tools).toEqual(['WebFetch', 'websearch']);
    // 库内可见
    expect(listPersonas().some((x) => x.id === armedId)).toBe(true);
  });
});

describe('chain_stats 极简日志', () => {
  it('completeTask 落单事件（breadthTier/toolChainCount/reworkCount）', () => {
    const { lead, p } = seed();
    const task = createTask(db, {
      projectId: p.id, assigneeAgentId: lead.id, title: '统计任务',
      inputProtocol: {
        breadthTier: 'heavy',
        resolvedToolChain: { defaultKit: [...DEFAULT_TOOL_KIT], tools: [{ toolId: 'x' }, { toolId: 'y' }], suggestedReplacements: [], gaps: [], resolvedAt: 't' },
      },
    });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);
    completeTask(db, task.id, { outcome: 'completed', summary: '完成', outboundTasks: [], artifacts: [] });
    const evt = listTaskEvents(db, task.id).find((e) => e.kind === 'chain_stats');
    expect(evt).toBeDefined();
    expect(evt!.payload).toMatchObject({ breadthTier: 'heavy', toolChainCount: 2, reworkCount: 0 });
  });
});
