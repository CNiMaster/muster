/**
 * 整改批次 4（收窄为守卫测试）：审查曾指认 memory_entry 的 scope CHECK 漂移（TS 枚举 'workspace' vs DB 旧 'company' 枚举）。
 * 实测迁移链终态 schema 已是 ('personal','workspace','project','craft')——前提不成立（指认读的是 0017 基础文件而非终态），
 * 本用例作为防回归守卫：任何 scope 枚举值都必须能落库，未来迁移若再漂移立即红。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgentProfile } from '../../src/server/domain/agent-profile';
import { createMemoryCandidate } from '../../src/server/domain/memory';
import { createProject } from '../../src/server/domain/project';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('memory scope CHECK 守卫', () => {
  it('全部四个 scope 枚举值均可落库（TS 枚举与 DB CHECK 不漂移）', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_guard', name: '工作台' });
    const projectForGuard = createProject(db, { companyId: workbench.id, name: '守卫项目', initialState: 'active' });
    for (const scope of ['personal', 'workspace', 'project', 'craft'] as const) {
      const profile = createAgentProfile(db, { displayName: `档案-${scope}` });
      const candidate = createMemoryCandidate(db, {
        profileId: profile.id,
        scope,
        ...(scope === 'project' ? { projectId: projectForGuard.id } : {}),
        ...(scope === 'craft' ? { personaKey: 'product/manager' } : {}),
        content: `守卫：${scope} 落库`,
        author: 'agent',
        confidence: 1,
        canInfluence: true,
        allowAutoApprove: true,
      });
      expect(candidate.scope).toBe(scope);
    }
    // 守卫口径：四个枚举值都能进候选表（CHECK 不漂移）；批准策略各 scope 不同属正常设计
    const rows = db.prepare('SELECT scope FROM memory_candidate').all() as Array<{ scope: string }>;
    expect(rows.map((r) => r.scope).sort()).toEqual(['craft', 'personal', 'project', 'workspace']);
  });
});
