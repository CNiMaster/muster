import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import { setDbForTest, getDb } from '../../src/server/db/client';
import { ensureWorkbench } from '../../src/server/domain/workbench';
import { createProject, listProjects } from '../../src/server/domain/project';
import type { DB } from '../../src/server/db/client';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
  setDbForTest(db);
});

describe('D-Task3 任务与知识资产表已无 company_id 列', () => {
  it('11 张资产/知识表列清单不含 company_id', () => {
    const tables = [
      'workflow_node',
      'workflow_edge',
      'project',
      'swarm_run',
      'trigger',
      'blueprint',
      'debate',
      'decision_record',
      'task_closeout_summary',
      'expert_candidate',
      'blueprint_optimization_item',
    ];
    for (const t of tables) {
      const cols = (getDb().prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);
      expect(cols, t).not.toContain('company_id');
    }
  });

  it('createProject 无 companyId 参数可建可查', () => {
    ensureWorkbench(getDb());
    const p = createProject(getDb(), {
      name: '测试项目',
      rootDir: '/tmp/test-proj-drop-3',
    });
    expect(p.name).toBe('测试项目');
    const list = listProjects(getDb());
    expect(list.some(x => x.id === p.id)).toBe(true);
  });
});
