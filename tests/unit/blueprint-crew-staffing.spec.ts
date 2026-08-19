/**
 * 蓝图专家组合（批次 J·修复轮）：
 * - 命中派整组：多槽蓝图命中且未显式指定执行者 → 主任务（槽0人设）+ 组员任务（同 project_task、
 *   parent 挂主任务、池内专家优先为执行者、显式 personaId 不再叠加匹配）
 * - 旧单人蓝图兼容：单槽不派组员
 * - 缺员降级留痕：池无专家/人设缺失 → blueprint_crew_slot_unfilled 事件，不造 agent
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';
import { createTask, listTasks } from '../../src/server/domain/task';
import { evolveBlueprint, getBlueprint } from '../../src/server/domain/blueprint';
import { listPersonas } from '../../src/server/domain/persona-library';
import { listTaskEvents } from '../../src/server/domain/task-event';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

function seedProject(tag: string) {
  const workbench = restoreWorkbench(db, { id: `wb_crew_${tag}`, name: '工作台' });
  const project = createProject(db, { companyId: workbench.id, name: '组合项目', initialState: 'active' });
  return { workbench, project };
}

describe('蓝图专家组合（批次 J·修复轮）', () => {
  it('命中派整组：主任务+组员任务各自为 runtime task，池内专家优先，缺员留痕不造人', () => {
    const { workbench, project } = seedProject('multi');
    const personas = listPersonas();
    const p0 = personas[0]!;
    const p1 = personas[1]!;
    const p2 = personas[2]!;

    const bp = evolveBlueprint(db, {
      companyId: workbench.id, projectId: project.id,
      taskTitle: '深度行业调研报告', personaId: p0.id, personaName: p0.name, win: true,
    })!;
    // 扩成 3 槽组合（含分工 role）
    db.prepare('UPDATE blueprint SET staffing_json=? WHERE id=?').run(
      JSON.stringify([
        { personaId: p0.id, personaName: p0.name, role: '统筹' },
        { personaId: p1.id, personaName: p1.name, role: '调研' },
        { personaId: p2.id, personaName: p2.name, role: '复核' },
      ]),
      bp.id,
    );
    expect(getBlueprint(db, bp.id).staffing).toHaveLength(3);

    // 池内专家：只给 p1 造常驻专家
    const specialist = createAgent(db, { companyId: workbench.id, name: `常驻-${p1.name}`, role: 'specialist' });
    db.prepare("INSERT INTO specialist_pool (id, project_id, persona_id, agent_id, specialty, status, use_count, created_at, updated_at) VALUES (?,?,?,?,?,'active',1,?,?)")
      .run('sp_test_1', project.id, p1.id, specialist.id, p1.name, new Date().toISOString(), new Date().toISOString());

    const primary = createTask(db, { projectId: project.id, title: '深度行业调研报告' });

    const tasks = listTasks(db, project.id);
    expect(tasks).toHaveLength(3); // 主 + 2 组员

    expect(primary.personaId).toBe(p0.id);

    const members = tasks.filter((t) => t.id !== primary.id);
    expect(members).toHaveLength(2);
    for (const m of members) {
      expect(m.parentTaskId).toBe(primary.id);
      expect(m.projectTaskId).toBe(primary.projectTaskId); // 同一项目任务载体（并行，无依赖链）
    }
    // p1 组员：池内专家为执行者
    const p1Member = members.find((m) => m.personaId === p1.id)!;
    expect(p1Member.assigneeAgentId).toBe(specialist.id);
    expect(p1Member.title).toContain('（调研）');
    // p2 组员：池无专家 → 无执行者 + 主任务留痕
    const p2Member = members.find((m) => m.personaId === p2.id)!;
    expect(p2Member.assigneeAgentId).toBeNull();
    const unfilled = listTaskEvents(db, primary.id).filter((e) => e.kind === 'blueprint_crew_slot_unfilled');
    expect(unfilled).toHaveLength(1);
    expect(String((unfilled[0]!.payload as Record<string, unknown>).personaId)).toBe(p2.id);
    // 组员不叠加蓝图匹配（exempt）
    expect((p1Member.inputProtocol as Record<string, unknown>).blueprintMatched).toBeUndefined();
  });

  it('旧单人蓝图兼容：单槽命中不派组员（零行为变化）', () => {
    const { workbench, project } = seedProject('single');
    const personas = listPersonas();
    evolveBlueprint(db, {
      companyId: workbench.id, projectId: project.id,
      taskTitle: '产品需求梳理', personaId: personas[0]!.id, personaName: personas[0]!.name, win: true,
    });
    createTask(db, { projectId: project.id, title: '产品需求梳理' });
    expect(listTasks(db, project.id)).toHaveLength(1);
  });

  it('显式指定执行者：只穿衣不换人，也不派整组', () => {
    const { workbench, project } = seedProject('explicit');
    const personas = listPersonas();
    const assigned = createAgent(db, { companyId: workbench.id, name: '指定执行者', role: 'engineer' });
    const bp = evolveBlueprint(db, {
      companyId: workbench.id, projectId: project.id,
      taskTitle: '品牌视觉设计', personaId: personas[0]!.id, personaName: personas[0]!.name, win: true,
    })!;
    db.prepare('UPDATE blueprint SET staffing_json=? WHERE id=?').run(
      JSON.stringify([
        { personaId: personas[0]!.id, personaName: personas[0]!.name },
        { personaId: personas[1]!.id, personaName: personas[1]!.name, role: '辅助' },
      ]),
      bp.id,
    );
    const t = createTask(db, { projectId: project.id, title: '品牌视觉设计', assigneeAgentId: assigned.id });
    expect(t.assigneeAgentId).toBe(assigned.id);
    expect(t.personaId).toBe(personas[0]!.id); // 穿人设
    expect(listTasks(db, project.id)).toHaveLength(1); // 不派组员
  });
});
