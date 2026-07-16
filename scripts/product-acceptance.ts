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
import { getCompanyTemplateInstallation, listCapabilityBindings } from '../src/server/domain/template-installation';
import { resolveTaskSkills } from '../src/server/domain/capability-binding';
import { refreshTemplateHealthFindings } from '../src/server/domain/template-health-findings';
import { syncToolRegistry, listTools, setDefaultTools, dispatchDefaultToolsToCompany, listCompanyTools } from '../src/server/domain/tool-registry';
import { seedDefaultCredentialDefinitions, dispatchDefaultCredentialsToCompany, listCompanyCredentials, resolveCredentialKey } from '../src/server/domain/credential-store';
import { importMaterial, listMaterials } from '../src/server/domain/material';
import { registerArtifact, artifactGallery } from '../src/server/domain/artifact';

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
  assert.equal(getCompanyTemplateInstallation(db, result.company.id).snapshot.name, draft.name, '必须保存用户确认的模板快照');
  assert.ok(listCapabilityBindings(db, result.company.id).some((binding) => binding.scope === 'field'), '模板字段能力必须绑定到具体员工');
  assert.ok(result.employees.every((employee) => getEmploymentHealth(db, employee.id).code === 'probe-missing'), '绑定后未探测不得误判为可运行');

  const now = nowIso();
  db.prepare(`INSERT INTO connection_probe (id,executor_profile_id,cache_key,kind,status,stdout,stderr,duration_ms,created_at,completed_at)
    VALUES ('acceptance_probe',?,'acceptance','connectivity','connected','','',1,?,?)`).run(executor.id, now, now);
  const health = result.employees.map((employee) => getEmploymentHealth(db, employee.id));
  assert.ok(health.every((item) => item.code === 'ready'), '探测成功且权限已绑定的员工应可运行');
  assert.doesNotMatch(JSON.stringify(health), /authorization|bearer|api[_-]?key|secret|password/i, '健康 DTO 不得包含凭据字段或授权头');

  const workOrder = createTask(db, { projectId: result.project.id, projectTaskId: result.projectTask.id, assigneeAgentId: result.employees[0]!.id, title: '完成验收工作单', requiredSkillIds: ['planning-and-task-breakdown'] });
  assert.equal(workOrder.projectTaskId, result.projectTask.id, '员工工作单必须属于首个项目任务');
  assert.equal(resolveTaskSkills(db, workOrder)[0]?.status, 'loaded', 'Task 要求的本地 Skill 必须按需加载');

  // 能力中心:工具档案扫描、默认派发到公司
  const toolSync = syncToolRegistry(db, path.resolve(here, '../tools'));
  assert.ok(toolSync.added >= 13, 'tools/ 目录工具档案必须完整扫描入库');
  setDefaultTools(db, ['whisper-local', 'ffmpeg']);
  dispatchDefaultToolsToCompany(db, result.company.id);
  const companyTools = listCompanyTools(db, result.company.id).filter((t) => t.enabled);
  assert.ok(companyTools.some((t) => t.id === 'whisper-local'), '默认工具必须派发到公司');
  assert.ok(listTools(db, { capabilityId: 'speech-to-text' }).length >= 2, '同一能力必须有本地和 API 两种实现');

  // 凭据库:seed 默认定义 + 公司派发 + 三层解析
  const credSeed = seedDefaultCredentialDefinitions(db);
  assert.ok(credSeed.added >= 3, '必须 seed 至少 3 个 LLM 默认凭据定义');
  dispatchDefaultCredentialsToCompany(db, result.company.id);
  const companyCreds = listCompanyCredentials(db, result.company.id);
  assert.ok(companyCreds.length >= 3, '默认凭据必须派发到公司');
  assert.ok(companyCreds.every((c) => c.enabled && c.overrideKey === null), '派发的凭据默认启用且无覆盖');
  // 三层解析:平台默认层
  const resolvedKey = resolveCredentialKey(db, null, result.company.id, 'cred_openai_key');
  assert.equal(resolvedKey, 'OPENAI_API_KEY', '凭据三层解析必须返回平台默认环境变量名');

  // 素材区:三选一导入(link 模式)
  const mat = importMaterial(db, result.project.id, { mode: 'link', sourceUrl: 'https://example.com/requirement.docx', name: '需求文档', tags: ['需求'] });
  assert.equal(mat.sourceType, 'link', '素材必须支持链接导入');
  assert.equal(listMaterials(db, result.project.id).length, 1, '素材列表必须包含导入的素材');

  // 成品区泛化:支持通用 kind(video/audio)
  registerArtifact(db, { projectId: result.project.id, kind: 'video', path: 'output/final.mp4', mergeStrategy: 'exclusive_lock' });
  const gallery = artifactGallery(db, result.project.id, 'type');
  assert.ok(gallery.some((g) => g.key === 'video'), '成品画廊必须支持通用 video kind');
  assert.equal(refreshTemplateHealthFindings(db, result.company.id).length, 0, '完整模板创建后不应产生运行健康问题');
  archiveProjectTask(db, result.projectTask.id);
  assert.throws(() => createTask(db, { projectId: result.project.id, projectTaskId: result.projectTask.id, title: '不应创建' }), /已归档/, '归档项目任务必须只读');
  console.log('Product acceptance passed: blueprint snapshot, fixed bindings, task-scoped skills, tool registry, credential store, material library, generalized artifacts, template health, work order and archive boundary.');
} finally {
  db.close();
}
