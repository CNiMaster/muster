/**
 * 词法增强（检索路线拍板项：只词法、不向量）：别名归一层 + 四路接入 + routing_miss 信号。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';
import { createTask } from '../../src/server/domain/task';
import { findBestAssignee } from '../../src/server/domain/agent-router';
import { expandMatchTokens } from '../../src/server/domain/memory';
import { expandTermAliases, isSameTerm, normalizeTerm } from '../../src/server/domain/matching/lexicon';
import { matchSkillsByContent } from '../../src/server/domain/skill-retrieval';
import { makeTestDb } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

describe('lexicon 别名归一层', () => {
  it('中英别名归一到同一 canonical', () => {
    expect(normalizeTerm('测试')).toBe(normalizeTerm('test'));
    expect(normalizeTerm('QA')).toBe(normalizeTerm('qa'));
    expect(isSameTerm('部署', 'deploy')).toBe(true);
    expect(isSameTerm('前端', 'backend')).toBe(false);
    // 未收录词：退回 trim+小写
    expect(normalizeTerm('  CustomSkill ')).toBe('customskill');
  });

  it('expandTermAliases 返回组内全部成员', () => {
    const aliases = expandTermAliases('测试');
    expect(aliases).toContain('test');
    expect(aliases).toContain('qa');
    expect(aliases).toContain('测试');
  });
});

describe('能力路由别名命中', () => {
  it("requiredCapabilities=['测试'] 命中 skills=['test'] 的 agent（此前静默 miss fallback 负责人）", () => {
    const workbench = restoreWorkbench(db, { id: 'wb_lex', name: '工作台' });
    const lead = createAgent(db, { companyId: workbench.id, name: '负责人', role: 'lead' });
    createAgent(db, { companyId: workbench.id, name: '测试工程师', role: 'specialist', skills: ['test'] });
    const hit = findBestAssignee(db, workbench.id, ['测试']);
    expect(hit).not.toBeNull();
    expect(hit!.name).toBe('测试工程师');
    void lead;
  });

  it('路由 miss 落 routing_miss 事件（不再静默 fallback）', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_rmiss', name: '工作台' });
    const lead = createAgent(db, { companyId: workbench.id, name: '负责人', role: 'lead' });
    const project = createProject(db, { companyId: workbench.id, name: '项目', firstAgentId: lead.id, initialState: 'active' });
    const task = createTask(db, {
      projectId: project.id,
      title: '需要没人会的能力',
      requiredCapabilityIds: ['quantum-compiling'],
    });
    const events = db.prepare("SELECT payload_json FROM task_event WHERE task_id=? AND kind='routing_miss'").all(task.id) as Array<{ payload_json: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload_json).toContain('quantum-compiling');
    // fallback 到负责人
    expect(task.assigneeAgentId).toBe(lead.id);
  });
});

describe('记忆检索词元别名扩展', () => {
  it('expandMatchTokens：中文查询扩展出英文别名 token', () => {
    const tokens = expandMatchTokens('部署测试');
    expect(tokens).toContain('部署');
    expect(tokens.some((t) => t === 'test' || t === 'qa')).toBe(true);
    expect(tokens.some((t) => t === 'deploy' || t === 'release')).toBe(true);
  });
});

describe('技能检索别名命中', () => {
  it('中文任务命中英文描述的技能（此前 token 子串永不交叉命中）', () => {
    const catalog = [
      { skillId: 'sk_test', name: 'test-writing', description: 'write unit tests and qa checklists' },
      { skillId: 'sk_other', name: 'cooking', description: 'make dinner recipes' },
    ];
    const hits = matchSkillsByContent(catalog, '为登录模块补充单元测试与测试用例', 3);
    expect(hits).toContain('sk_test');
    expect(hits).not.toContain('sk_other');
  });
});
