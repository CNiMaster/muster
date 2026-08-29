/**
 * 进化蓝图 AI 定名（批次 A2，2026-08-29）：反思 drain 新建簇首建时机会主义改名，fail-open。
 * - 新建蓝图（版本链仅一条「创建蓝图」）→ LLM 给好名则改名+出版；LLM 失败/坏载荷保持拼名不阻断
 * - 非新建（已有第二条版本）→ 不触发 LLM
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb, createNovelCompany } from '../integration/setup';

vi.mock('../../src/server/domain/llm-call', () => ({ callLlm: vi.fn() }));
import { callLlm } from '../../src/server/domain/llm-call';
const callLlmMock = callLlm as unknown as ReturnType<typeof vi.fn>;

import { createProject } from '../../src/server/domain/project';
import { evolveBlueprint, getBlueprint, listBlueprintVersions } from '../../src/server/domain/blueprint';
import { maybeNameNewBlueprint } from '../../src/server/domain/reflection';
import { listPersonas } from '../../src/server/domain/persona-library';

let db: DB;
let companyId: string;
let projectId: string;

beforeEach(() => {
  callLlmMock.mockReset();
  const tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  companyId = r.company.id;
  projectId = createProject(db, { companyId, name: 'p', rootDir: '/tmp/naming', firstAgentId: r.agents.lead.id, initialState: 'active' }).id;
});

function newBlueprint() {
  const persona = listPersonas()[0]!;
  return evolveBlueprint(db, {
    companyId, projectId, taskTitle: '写一份新能源行业季度观察_xyz',
    personaId: persona.id, personaName: persona.name, win: true,
  })!;
}

describe('maybeNameNewBlueprint（fail-open）', () => {
  it('新建蓝图 + LLM 给好名 → 改名出版；返回新名', async () => {
    const bp = newBlueprint();
    callLlmMock.mockResolvedValueOnce({ content: '{"label":"行业观察报告"}' });
    const renamed = await maybeNameNewBlueprint(db, bp);
    expect(renamed).toBe('行业观察报告');
    expect(getBlueprint(db, bp.id).label).toBe('行业观察报告');
    const versions = listBlueprintVersions(db, bp.id);
    expect(versions[0]!.summary).toContain('改名');
    expect(versions).toHaveLength(2);
  });

  it('LLM 不可用 → 保持拼名不阻断（返回 null）', async () => {
    const bp = newBlueprint();
    callLlmMock.mockRejectedValueOnce(new Error('no credentials'));
    const renamed = await maybeNameNewBlueprint(db, bp);
    expect(renamed).toBeNull();
    expect(getBlueprint(db, bp.id).label).toBe(bp.label);
    expect(listBlueprintVersions(db, bp.id)).toHaveLength(1);
  });

  it('坏载荷（无 label/超长/同名）→ 不采纳', async () => {
    const bp = newBlueprint();
    callLlmMock.mockResolvedValueOnce({ content: '我觉得应该叫一个好名字' }); // 非 JSON
    expect(await maybeNameNewBlueprint(db, bp)).toBeNull();

    const bp2 = newBlueprint();
    callLlmMock.mockResolvedValueOnce({ content: '{"label":"x".repeat(99)}' }); // 超长（字符串整体超 40）
    expect(await maybeNameNewBlueprint(db, bp2)).toBeNull();
    expect(getBlueprint(db, bp2.id).label).toBe(bp2.label);
  });

  it('非新建（版本链已 ≥2）→ 不触发 LLM', async () => {
    const bp = newBlueprint();
    db.prepare("UPDATE blueprint SET description='手动调过' WHERE id=?").run(bp.id);
    const { commitBlueprintVersion } = await import('../../src/server/domain/blueprint');
    commitBlueprintVersion(db, bp.id, '描述更新：测试制造第二版', ['test']);
    const renamed = await maybeNameNewBlueprint(db, getBlueprint(db, bp.id));
    expect(renamed).toBeNull();
    expect(callLlmMock).not.toHaveBeenCalled();
  });
});
