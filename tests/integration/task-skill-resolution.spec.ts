import { restoreWorkbench } from '../../src/server/domain/workbench';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../../src/server/domain/agent';
;
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { resolveTaskSkills } from '../../src/server/domain/capability-binding';
import { assembleContext } from '../../src/server/executors/context';
import { nowIso, shortId } from '../../src/shared/utils';
import { makeTestDb } from './setup';

function insertBinding(db: ReturnType<typeof makeTestDb>['db'], input: {
  employeeId: string;
  scope: 'employee' | 'field';
  scopeKey: string;
  capabilityId: string;
  skillIds: string[];
}): void {
  const now = nowIso();
  db.prepare(`INSERT INTO capability_binding
    (id, employee_id, scope, scope_key, capability_id, skill_ids_json, purpose, load_when, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(shortId('cb_'), input.employeeId, input.scope, input.scopeKey,
      input.capabilityId, JSON.stringify(input.skillIds), `处理 ${input.scopeKey}`, 'Task 命中时', now, now);
}

describe('task skill resolution', () => {
  it('loads explicit, field, and employee bindings while omitting unrelated legacy skills', () => {
    const { db, close } = makeTestDb();
    try {
      const company = restoreWorkbench(db, { id: 'wb_fix_1', name: 'Acme' });
      const engineer = createAgent(db, {
        companyId: company.id,
        name: '工程师',
        role: 'engineer',
        skills: ['code-simplification', 'performance-optimization'],
      });
      const project = createProject(db, { companyId: company.id, name: '产品' });
      insertBinding(db, { employeeId: engineer.id, scope: 'field', scopeKey: 'requirement.title', capabilityId: 'requirements', skillIds: ['spec-driven-development'] });
      insertBinding(db, { employeeId: engineer.id, scope: 'employee', scopeKey: engineer.id, capabilityId: 'quality', skillIds: ['code-review-and-quality'] });
      insertBinding(db, { employeeId: engineer.id, scope: 'employee', scopeKey: `${engineer.id}:unrelated`, capabilityId: 'shipping', skillIds: ['shipping-and-launch'] });

      const task = createTask(db, {
        projectId: project.id,
        assigneeAgentId: engineer.id,
        title: '实现需求',
        requiredSkillIds: ['incremental-implementation', 'missing-business-skill'],
        knowledgeTargets: ['requirement.title'],
        requiredCapabilityIds: ['quality'],
      });

      const resolved = resolveTaskSkills(db, task);
      expect(resolved).toEqual(expect.arrayContaining([
        expect.objectContaining({ skillId: 'incremental-implementation', source: 'task', status: 'loaded', required: true }),
        expect.objectContaining({ skillId: 'missing-business-skill', source: 'task', status: 'missing' }),
        expect.objectContaining({ skillId: 'spec-driven-development', source: 'field', status: 'loaded' }),
        expect.objectContaining({ skillId: 'code-review-and-quality', source: 'employee', status: 'loaded' }),
      ]));
      expect(resolved.map((skill) => skill.skillId)).not.toContain('shipping-and-launch');
      expect(resolved.map((skill) => skill.skillId)).not.toContain('performance-optimization');

      const context = assembleContext(db, task);
      expect(context.systemPrompt).toContain('# 本 Task 按需加载的 Skill');
      expect(context.systemPrompt).toContain('incremental-implementation');
      expect(context.systemPrompt).toContain('来源：Task 明确要求');
      expect(context.systemPrompt).toContain('missing-business-skill：未找到');
      expect(context.systemPrompt).not.toContain(readFileSync(path.join(process.cwd(), 'skills/performance-optimization/SKILL.md'), 'utf8'));
    } finally {
      close();
    }
  });

  it('uses legacy agent skills only when the task has no binding metadata', () => {
    const { db, close } = makeTestDb();
    try {
      const company = restoreWorkbench(db, { id: 'wb_fix_2', name: 'Legacy' });
      const agent = createAgent(db, { companyId: company.id, name: '旧员工', role: 'worker', skills: ['code-simplification'] });
      const project = createProject(db, { companyId: company.id, name: '旧项目' });
      const task = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '旧任务' });

      expect(resolveTaskSkills(db, task)).toContainEqual(expect.objectContaining({
        skillId: 'code-simplification', source: 'legacy', status: 'loaded', required: false,
      }));
    } finally {
      close();
    }
  });
});
