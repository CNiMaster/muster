import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/server/db/client';
import { previewCompanySetup, commitCompanySetup } from '../src/server/domain/company-setup';
import { createExecutorProfile } from '../src/server/domain/executor-profile';
import { getEmploymentHealth } from '../src/server/domain/executor-health';
import { createPermissionPolicy } from '../src/server/domain/permission';
import { archiveProjectTask } from '../src/server/domain/project-task';
import { createTask } from '../src/server/domain/task';
import { nowIso } from '../src/shared/utils';

const here = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
runMigrations(db, path.resolve(here, '../src/server/db/migrations'));

try {
  const executor = createExecutorProfile(db, { name: '验收 API 执行器', manifestId: 'openai-compatible-api' });
  const policy = createPermissionPolicy(db, { name: '验收项目权限', approvalStrategy: 'ask-by-rule', scope: 'project' });
  const draft = previewCompanySetup({ templateId: 'software', name: '验收软件公司', goal: '交付一个可运行的产品' });
  const bindings = Object.fromEntries(draft.employees.map((employee) => [employee.key, { executorProfileId: executor.id, permissionPolicyId: policy.id }]));
  const result = commitCompanySetup(db, draft, bindings);
  assert.equal(result.employees.length, draft.employees.length, '模板员工必须完整创建');
  assert.ok(result.employees.every((employee) => getEmploymentHealth(db, employee.id).code === 'probe-missing'), '绑定后未探测不得误判为可运行');

  const now = nowIso();
  db.prepare(`INSERT INTO connection_probe (id,executor_profile_id,cache_key,kind,status,stdout,stderr,duration_ms,created_at,completed_at)
    VALUES ('acceptance_probe',?,'acceptance','connectivity','connected','','',1,?,?)`).run(executor.id, now, now);
  const health = result.employees.map((employee) => getEmploymentHealth(db, employee.id));
  assert.ok(health.every((item) => item.code === 'ready'), '探测成功且权限已绑定的员工应可运行');
  assert.doesNotMatch(JSON.stringify(health), /authorization|bearer|api[_-]?key|secret|password/i, '健康 DTO 不得包含凭据字段或授权头');

  const workOrder = createTask(db, { projectId: result.project.id, projectTaskId: result.projectTask.id, assigneeAgentId: result.employees[0]!.id, title: '完成验收工作单' });
  assert.equal(workOrder.projectTaskId, result.projectTask.id, '员工工作单必须属于首个项目任务');
  archiveProjectTask(db, result.projectTask.id);
  assert.throws(() => createTask(db, { projectId: result.project.id, projectTaskId: result.projectTask.id, title: '不应创建' }), /已归档/, '归档项目任务必须只读');
  console.log('Product acceptance passed: template setup, fixed bindings, truthful health, work order and archive boundary.');
} finally {
  db.close();
}
