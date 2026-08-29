/**
 * 人设库去重（蓝图工作流化批次 A1，2026-08-29）：8 组跨域孪生归一到域目录正身。
 * - 库唯一性守卫：listPersonas 名字唯一、8 个旧 engineering/ id 不再可解析
 * - 预设引用归一：软件交付/数据分析/网站开发/CI-CD 四套的班底槽全部指向正身 id
 * - 迁移语义：模拟 2026-08-28 版播种的存量蓝图行（staffing/snapshot 含旧 id）+ 旧 id 用户人才行，
 *   重放迁移 SQL 的 REPLACE 语义后全部归一（直接执行同一 SQL 文件内容，防「两处各写一套」漂移）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb, createNovelCompany } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { listPersonas, getPersona } from '../../src/server/domain/persona-library';
import { BLUEPRINT_PRESETS, ensureBlueprintPresets } from '../../src/server/domain/blueprint-presets';
import { listBlueprints, getBlueprint } from '../../src/server/domain/blueprint';

const MIGRATION_FILE = join(__dirname, '../../src/server/db/migrations/20260829150000_persona_dedup_canonical.sql');

const CANONICAL: Array<[oldId: string, newId: string]> = [
  ['engineering/engineering-frontend-developer', 'frontend/engineering-frontend-developer'],
  ['engineering/engineering-mobile-app-builder', 'frontend/engineering-mobile-app-builder'],
  ['engineering/engineering-backend-architect', 'backend/engineering-backend-architect'],
  ['engineering/engineering-data-engineer', 'backend/engineering-data-engineer'],
  ['engineering/engineering-database-optimizer', 'backend/engineering-database-optimizer'],
  ['engineering/engineering-devops-automator', 'devops/engineering-devops-automator'],
  ['engineering/engineering-sre', 'devops/engineering-sre'],
  ['engineering/engineering-security-engineer', 'security/engineering-security-engineer'],
];

let db: DB;
let projectId: string;

beforeEach(() => {
  db = makeTestDb().db;
  const wb = restoreWorkbench(db, { id: 'wb_dedup', name: 'co' });
  const r = createNovelCompany(db, { name: 'co' });
  const project = createProject(db, { companyId: r.company.id, name: '去重项目', rootDir: '/tmp/dedup', firstAgentId: r.agents.lead.id, initialState: 'active' });
  projectId = project.id;
  void wb;
});

describe('人设库唯一性', () => {
  it('删除孪生后名字全局唯一；8 个旧 engineering/ id 不再可解析，正身全部可解析', () => {
    const personas = listPersonas();
    const names = personas.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [oldId, newId] of CANONICAL) {
      expect(getPersona(oldId), `${oldId} 应已删除`).toBeNull();
      expect(getPersona(newId), `${newId} 应存在`).not.toBeNull();
      expect(getPersona(newId)!.domain).toBe(newId.split('/')[0]);
    }
  });

  it('预设四套（软件交付/数据分析/网站开发/CI-CD）班底槽全部指向正身 id', () => {
    const byLabel = new Map(BLUEPRINT_PRESETS.map((p) => [p.label, p]));
    expect(byLabel.get('软件交付')!.staffing[1]!.personaId).toBe('frontend/engineering-frontend-developer');
    expect(byLabel.get('数据分析及可视化')!.staffing[0]!.personaId).toBe('backend/engineering-data-engineer');
    expect(byLabel.get('网站开发')!.staffing[1]!.personaId).toBe('backend/engineering-backend-architect');
    expect(byLabel.get('CI/CD 流水线')!.staffing[0]!.personaId).toBe('devops/engineering-devops-automator');

    // 播种后穿戴链路可用：主槽（软件架构师，engineering 独有）与协作槽（前端开发者，正身）都真实存在
    ensureBlueprintPresets(db);
    const sw = listBlueprints(db).find((bp) => bp.label === '软件交付')!;
    expect(sw.staffing[0]!.personaId).toBe('engineering/engineering-software-architect');
    const task = createTask(db, { projectId, title: '修复登录 bug', blueprintId: sw.id });
    expect(task.personaId).toBe('engineering/engineering-software-architect');
  });
});

describe('存量数据迁移语义（重放迁移 SQL 文件本身）', () => {
  it('蓝图 staffing/snapshot、任务阶段绑定、用户人才绑定中的旧 id 全部归一', () => {
    ensureBlueprintPresets(db);
    const sw = listBlueprints(db).find((bp) => bp.label === '软件交付')!;
    const legacyTask = createTask(db, { projectId, title: '迁移语义载体任务' });
    // 人为把一行蓝图回退到旧 id（模拟 2026-08-28 版播种的存量）
    db.prepare('UPDATE blueprint SET staffing_json=? WHERE id=?').run(
      JSON.stringify([
        { personaId: 'engineering/engineering-software-architect', personaName: '软件架构师', role: '设计与实现' },
        { personaId: 'engineering/engineering-frontend-developer', personaName: '前端开发者', role: '界面实现' },
        { personaId: 'engineering/engineering-sre', personaName: 'SRE', role: '稳定性' },
      ]),
      sw.id,
    );
    db.prepare('UPDATE blueprint SET preset_snapshot_json=? WHERE id=?').run(
      JSON.stringify({ taskType: sw.taskType, label: sw.label, description: sw.description, staffing: [{ personaId: 'engineering/engineering-sre', personaName: 'SRE' }], stages: [] }),
      sw.id,
    );
    // 模拟旧 id 的用户人才与阶段绑定
    db.prepare(
      `INSERT INTO agent_profile (id, display_name, source_persona_id, source, capabilities_json, is_auto_dispatch, created_at, updated_at)
       VALUES ('ap_dedup_1', '我的前端', 'engineering/engineering-frontend-developer', 'user',
         '{"domain":"engineering","personaId":"engineering/engineering-frontend-developer"}', 1, ?, ?)`,
    ).run('2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z');
    db.prepare(
      `INSERT INTO task_stage_run (id, task_id, project_id, blueprint_id, stage_id, step, label, status, attempt, artifacts_json, created_at, updated_at, staffing_persona_ids_json)
       VALUES ('tsr_dedup_1', ?, ?, ?, 's1', 1, 'x', 'running', 1, '[]', ?, ?, '["engineering/engineering-sre"]')`,
    ).run(legacyTask.id, projectId, sw.id, '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z');

    db.exec(readFileSync(MIGRATION_FILE, 'utf-8')); // 幂等重放迁移本身

    const after = getBlueprint(db, sw.id);
    expect(after.staffing.map((s) => s.personaId)).toEqual([
      'engineering/engineering-software-architect', // 真 engineering 独有人设不动
      'frontend/engineering-frontend-developer',
      'devops/engineering-sre',
    ]);
    expect(JSON.stringify(after.presetSnapshot)).toContain('devops/engineering-sre');
    expect(JSON.stringify(after.presetSnapshot)).not.toContain('engineering/engineering-sre');

    const profile = db.prepare('SELECT source_persona_id, capabilities_json FROM agent_profile WHERE id=?').get('ap_dedup_1') as { source_persona_id: string; capabilities_json: string };
    expect(profile.source_persona_id).toBe('frontend/engineering-frontend-developer');
    expect(profile.capabilities_json).toContain('"domain":"frontend"');
    expect(profile.capabilities_json).toContain('"personaId":"frontend/engineering-frontend-developer"');

    const stage = db.prepare('SELECT staffing_persona_ids_json FROM task_stage_run WHERE id=?').get('tsr_dedup_1') as { staffing_persona_ids_json: string };
    expect(stage.staffing_persona_ids_json).toBe('["devops/engineering-sre"]');

    // 真工程独有人设的 domain 不被误伤（无 source 命中即不动）
    const untouched = db.prepare('SELECT COUNT(*) c FROM agent_profile WHERE capabilities_json LIKE \'%"domain":"engineering"%\' AND source_persona_id NOT LIKE \'%/%\'').get() as { c: number };
    expect(untouched.c).toBe(0);
  });
});
