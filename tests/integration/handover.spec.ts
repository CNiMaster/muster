/**
 * 离职交接工作流测试（批次 C）：四阶段 + owner 转移 + 连环交接。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import {
  createHandover,
  updateHandoverContent,
  assignReceiver,
  startReceiving,
  transferArtifactsInHandover,
  completeHandover,
  cancelHandover,
  offboardEmployee,
} from '../../src/server/domain/handover';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;
let departingId: string;
let receiverId: string;
let projectId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  companyId = createCompany(db, { name: '交接公司' }).id;
  departingId = createAgent(db, {
    companyId, name: '离职员工', role: 'engineer', systemPrompt: '', skills: [], tools: [], permissions: {}, executor: {},
  }).id;
  receiverId = createAgent(db, {
    companyId, name: '接手人', role: 'engineer', systemPrompt: '', skills: [], tools: [], permissions: {}, executor: {},
  }).id;
  db.prepare("UPDATE company SET state='online', first_agent_id=? WHERE id=?").run(receiverId, companyId);
  projectId = createProject(db, { companyId, name: '项目', initialState: 'active' }).id;
});

afterEach(() => tdb.close());

/** 直接插入 artifact 行（绕过 task FK）。 */
function insertArtifact(path: string, owner: string): string {
  const id = `ar_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO artifact (id, project_id, kind, path, owner_agent_id, merge_strategy, props_json, created_task_id, created_at, updated_at)
     VALUES (?, ?, 'document', ?, ?, 'three_way', '{}', NULL, ?, ?)`,
  ).run(id, projectId, path, owner, now, now);
  return id;
}

describe('交接阶段 1：创建 + drafting', () => {
  it('创建交接记录，自动汇总产物清单', () => {
    insertArtifact('a.md', departingId);
    insertArtifact('b.md', departingId);
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    expect(record.state).toBe('drafting');
    expect(record.artifactInventory).toHaveLength(1); // 1 个项目
    expect(record.artifactInventory[0].items).toHaveLength(2); // 2 个产物
    expect(record.departingProfileId).toBeTruthy();
  });

  it('无产物时清单为空', () => {
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    expect(record.artifactInventory).toHaveLength(0);
  });

  it('已有未完成交接时报错', () => {
    createHandover(db, { companyId, departingEmployeeId: departingId });
    expect(() => createHandover(db, { companyId, departingEmployeeId: departingId })).toThrow(/未完成/);
  });

  it('更新交接内容（记录/经验/待办）', () => {
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    const updated = updateHandoverContent(db, record.id, {
      handoverNote: '工作交接记录',
      lessons: ['经验1', '经验2'],
      pendingWork: [{ title: '待办1', detail: '细节' }],
    });
    expect(updated.handoverNote).toBe('工作交接记录');
    expect(updated.lessons).toEqual(['经验1', '经验2']);
    expect(updated.pendingWork).toHaveLength(1);
  });

  it('非 drafting 态不能更新内容', () => {
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    assignReceiver(db, record.id, receiverId);
    expect(() => updateHandoverContent(db, record.id, { handoverNote: 'x' })).toThrow(/drafting/);
  });
});

describe('交接阶段 2：指定接手人', () => {
  it('drafting → awaiting', () => {
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    const assigned = assignReceiver(db, record.id, receiverId);
    expect(assigned.state).toBe('awaiting');
    expect(assigned.receiverEmployeeId).toBe(receiverId);
  });

  it('不能交接给自己', () => {
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    expect(() => assignReceiver(db, record.id, departingId)).toThrow(/自己/);
  });

  it('接手人不属于该公司报错', () => {
    db.prepare("UPDATE company SET state='off' WHERE id=?").run(companyId);
    const other = createAgent(db, {
      companyId: createCompany(db, { name: '其他公司' }).id,
      name: '外人', role: 'x', systemPrompt: '', skills: [], tools: [], permissions: {}, executor: {},
    }).id;
    db.prepare("UPDATE company SET state='online' WHERE id=?").run(companyId);
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    expect(() => assignReceiver(db, record.id, other)).toThrow(/不属于/);
  });
});

describe('交接阶段 3：接收 + 产物转移', () => {
  it('awaiting → receiving → transfer → owner 指针更新', () => {
    insertArtifact('a.md', departingId);
    insertArtifact('b.md', departingId);
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    assignReceiver(db, record.id, receiverId);
    startReceiving(db, record.id);
    const { transferred } = transferArtifactsInHandover(db, record.id, projectId);
    expect(transferred).toBe(2);
    // 验证 owner 已转移
    const owners = db.prepare('SELECT owner_agent_id FROM artifact WHERE project_id=? ORDER BY path').all(projectId) as { owner_agent_id: string }[];
    expect(owners.every((o) => o.owner_agent_id === receiverId)).toBe(true);
    // 清单标记 transferred
    const updated = db.prepare('SELECT artifact_inventory_json FROM handover_record WHERE id=?').get(record.id) as { artifact_inventory_json: string };
    const inv = JSON.parse(updated.artifact_inventory_json);
    expect(inv[0].items.every((it: { transferred: boolean }) => it.transferred)).toBe(true);
  });

  it('非 receiving 态不能转移', () => {
    insertArtifact('a.md', departingId);
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    assignReceiver(db, record.id, receiverId);
    expect(() => transferArtifactsInHandover(db, record.id, projectId)).toThrow(/receiving/);
  });
});

describe('交接阶段 4：完成（离职生效）', () => {
  it('receiving → completed，员工任职删除', () => {
    insertArtifact('a.md', departingId);
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    assignReceiver(db, record.id, receiverId);
    startReceiving(db, record.id);
    transferArtifactsInHandover(db, record.id, projectId);
    const completed = completeHandover(db, record.id);
    expect(completed.state).toBe('completed');
    expect(completed.completedAt).toBeTruthy();
    // 员工任职已删
    const stillExists = db.prepare('SELECT id FROM agent_definition WHERE id=?').get(departingId);
    expect(stillExists).toBeUndefined();
  });

  it('未指定接手人不能完成', () => {
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    expect(() => completeHandover(db, record.id)).toThrow(/接手人/);
  });
});

describe('连环交接（owner 始终单一）', () => {
  it('A→B→C：最终 owner 是 C（不叠加）', () => {
    insertArtifact('doc.md', departingId);
    // A→B
    const r1 = createHandover(db, { companyId, departingEmployeeId: departingId });
    assignReceiver(db, r1.id, receiverId);
    startReceiving(db, r1.id);
    transferArtifactsInHandover(db, r1.id, projectId);
    completeHandover(db, r1.id);
    // 现在 owner 是 B（receiverId）
    let owner = db.prepare('SELECT owner_agent_id FROM artifact WHERE path=?').get('doc.md') as { owner_agent_id: string };
    expect(owner.owner_agent_id).toBe(receiverId);
    // B→C：新建第三人
    db.prepare("UPDATE company SET state='off' WHERE id=?").run(companyId);
    const personC = createAgent(db, {
      companyId, name: 'C', role: 'engineer', systemPrompt: '', skills: [], tools: [], permissions: {}, executor: {},
    }).id;
    db.prepare("UPDATE company SET state='online' WHERE id=?").run(companyId);
    const r2 = createHandover(db, { companyId, departingEmployeeId: receiverId });
    assignReceiver(db, r2.id, personC);
    startReceiving(db, r2.id);
    transferArtifactsInHandover(db, r2.id, projectId);
    completeHandover(db, r2.id);
    // 最终 owner 是 C（单一指针，不是 A+B+C）
    owner = db.prepare('SELECT owner_agent_id FROM artifact WHERE path=?').get('doc.md') as { owner_agent_id: string };
    expect(owner.owner_agent_id).toBe(personC);
  });
});

describe('取消交接 + offboardEmployee', () => {
  it('取消交接', () => {
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    const cancelled = cancelHandover(db, record.id);
    expect(cancelled.state).toBe('cancelled');
  });

  it('completed 态不能取消', () => {
    insertArtifact('a.md', departingId);
    const record = createHandover(db, { companyId, departingEmployeeId: departingId });
    assignReceiver(db, record.id, receiverId);
    startReceiving(db, record.id);
    transferArtifactsInHandover(db, record.id, projectId);
    completeHandover(db, record.id);
    expect(() => cancelHandover(db, record.id)).toThrow();
  });

  it('offboardEmployee 创建交接记录', () => {
    const record = offboardEmployee(db, companyId, departingId);
    expect(record.state).toBe('drafting');
    expect(record.departingEmployeeId).toBe(departingId);
  });
});
