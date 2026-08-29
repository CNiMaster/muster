/**
 * 蓝图工具记账带 kind（蓝图工作流化批次 A4，2026-08-29）：
 * - collectTaskToolUsage：tool_call 按 mcp_ 前缀分流 mcp/tool；技能从 resolvedSkillIds 计一次 skill；
 *   file_edit 等其他 trace kind 不进工具账。
 * - mergeTools/evolveBlueprintById：同 id 不同 kind 各记一条（skill:edit_file ≠ tool:edit_file）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb, createNovelCompany } from '../integration/setup';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { evolveBlueprint, evolveBlueprintById, getBlueprint } from '../../src/server/domain/blueprint';
import { collectTaskToolUsage } from '../../src/server/domain/reflection';
import { listPersonas } from '../../src/server/domain/persona-library';

let db: DB;
let companyId: string;
let projectId: string;

beforeEach(() => {
  db = makeTestDb().db;
  const r = createNovelCompany(db, { name: 'co' });
  companyId = r.company.id;
  projectId = createProject(db, { companyId, name: 'p', rootDir: '/tmp/toolkind', firstAgentId: r.agents.lead.id, initialState: 'active' }).id;
});

describe('collectTaskToolUsage', () => {
  it('tool_call 分流 tool/mcp；技能计一次 skill；file_edit 不进账', () => {
    const persona = listPersonas()[0]!;
    const task = createTask(db, {
      projectId,
      title: '工具记账测试',
      personaId: persona.id,
      inputProtocol: { resolvedSkillIds: ['doc-writer'] },
    });
    const now = new Date().toISOString();
    const ins = db.prepare(
      `INSERT INTO execution_trace (id, task_id, run_id, seq, kind, name, summary, payload_json, occurred_at)
       VALUES (?, ?, NULL, ?, ?, ?, '', '{}', ?)`,
    );
    ins.run('tr_1', task.id, 1, 'tool_call', 'edit_file', now);
    ins.run('tr_2', task.id, 2, 'tool_call', 'mcp_github__create_issue', now);
    ins.run('tr_3', task.id, 3, 'file_edit', 'Write', now);
    ins.run('tr_4', task.id, 4, 'tool_call', 'edit_file', now); // 同名 DISTINCT 去重

    const used = collectTaskToolUsage(db, getTaskRow(task.id));
    expect(used).toEqual([
      { id: 'edit_file', kind: 'tool' },
      { id: 'mcp_github__create_issue', kind: 'mcp' },
      { id: 'doc-writer', kind: 'skill' },
    ]);
  });

  it('无 trace 无技能 → 空数组（不阻断反思）', () => {
    const task = createTask(db, { projectId, title: '空账任务' });
    expect(collectTaskToolUsage(db, getTaskRow(task.id))).toEqual([]);
  });

  function getTaskRow(taskId: string): { id: string; inputProtocol: Record<string, unknown> } {
    const row = db.prepare('SELECT id, input_protocol_json FROM task WHERE id=?').get(taskId) as { id: string; input_protocol_json: string };
    return { id: row.id, inputProtocol: JSON.parse(row.input_protocol_json ?? '{}') };
  }
});

describe('mergeTools 分流（经 evolveBlueprintById/evolveBlueprint 行为断言）', () => {
  it('同 id 不同 kind 各记一条；同 kind 同 id 计数累加', () => {
    const persona = listPersonas()[0]!;
    const bp = evolveBlueprint(db, {
      companyId, projectId, taskTitle: '工具分流测试_xyz',
      personaId: persona.id, personaName: persona.name, win: true,
      tools: [
        { id: 'edit_file', kind: 'tool' },
        { id: 'edit_file', kind: 'skill' },
        { id: 'mcp_github__create_issue', kind: 'mcp' },
      ],
    })!;
    let tools = getBlueprint(db, bp.id).tools;
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => `${t.kind}:${t.id}`).sort()).toEqual([
      'mcp:mcp_github__create_issue',
      'skill:edit_file',
      'tool:edit_file',
    ]);

    // 第二次同款使用：uses 累加不新增条目
    evolveBlueprintById(db, {
      blueprintId: bp.id, projectId, personaId: persona.id, personaName: persona.name, win: true,
      tools: [{ id: 'edit_file', kind: 'tool' }],
    });
    tools = getBlueprint(db, bp.id).tools;
    expect(tools).toHaveLength(3);
    expect(tools.find((t) => t.kind === 'tool' && t.id === 'edit_file')!.uses).toBe(2);
    expect(tools.find((t) => t.kind === 'skill' && t.id === 'edit_file')!.uses).toBe(1);
  });
});
