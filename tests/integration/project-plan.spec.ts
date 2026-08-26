/**
 * capability parity 批次 G：计划版本域——createPlanVersion 版本递进/activate 替代语义。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createProject } from '../../src/server/domain/project';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from '../integration/setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { createPlanVersion, listPlanVersions, getActivePlanVersion, activatePlanVersion } from '../../src/server/domain/project-plan';

let db: DB;
let projectId: string;

beforeEach(() => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  const wb = restoreWorkbench(db, { id: 'wb_plan', name: '计划测试台' });
  projectId = createProject(db, { companyId: wb.id, name: 'p', rootDir: makeTempGitRepo(), initialState: 'active' }).id;
});

describe('project-plan（批次 G 接线后）', () => {
  it('createPlanVersion 版本递进；activate 后旧 active 转 superseded', () => {
    const v1 = createPlanVersion(db, projectId, { planDocRef: 'docs/plan-v1.md', createdReason: 'manual', status: 'draft' });
    expect(v1.version).toBe(1);
    expect(v1.status).toBe('draft');
    activatePlanVersion(db, projectId, v1.id);
    expect(getActivePlanVersion(db, projectId)?.id).toBe(v1.id);
    const v2 = createPlanVersion(db, projectId, { planDocRef: 'docs/plan-v2.md', createdReason: 'scope-change', status: 'draft' });
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('draft');
    activatePlanVersion(db, projectId, v2.id);
    const versions = listPlanVersions(db, projectId);
    expect(versions).toHaveLength(2);
    expect(getActivePlanVersion(db, projectId)?.id).toBe(v2.id);
    expect(versions.find((v) => v.id === v1.id)?.status).toBe('superseded');
  });

  it('activate 不存在版本 404；跨项目隔离', () => {
    const p2 = createProject(db, { companyId: 'wb_plan', name: 'p2', rootDir: makeTempGitRepo(), initialState: 'active' }).id;
    const v1 = createPlanVersion(db, projectId, {});
    expect(() => activatePlanVersion(db, p2, v1.id)).toThrow();
    expect(() => activatePlanVersion(db, projectId, 'pl_none')).toThrow();
    expect(listPlanVersions(db, p2)).toHaveLength(0);
  });
});
