/**
 * 批次 D1：对话附件链路
 * - 上传文件入库素材区（materials/_uploads）并登记 material 行
 * - 消息携带 attachments 落库（attachments_json）
 * - 派发 Task 的 inputProtocol 带附件路径提示（CLI 在 worktree 内可按相对路径读取）
 * - 附件归属校验：不属于该项目的素材被拒绝
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createNovelCompany } from '../../src/server/domain/novel-template';
import { createProject } from '../../src/server/domain/project';
import { importUploadedFile } from '../../src/server/domain/material';
import { listMessages, postUserMessage } from '../../src/server/domain/conversation';
import { listTasks } from '../../src/server/domain/task';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

function tempProjectRoot(tag: string): string {
  const root = path.join(tmpdir(), `muster-attach-${tag}-${Date.now()}`);
  mkdirSync(path.join(root), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), 'placeholder');
  return root;
}

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('message attachments', () => {
  it('上传入库 → 消息带附件 → Task inputProtocol 注入附件路径', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const rootDir = tempProjectRoot('a');
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'proj',
      rootDir,
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
    });

    const material = importUploadedFile(db, project.id, {
      data: Buffer.from('需求草稿内容'),
      originalName: '../../需求草稿.md',
      mime: 'text/markdown',
    });
    // 文件名净化：不逃逸、保留原名
    expect(material.name).toBe('需求草稿.md');
    expect(material.sourceType).toBe('upload');
    expect(existsSync(path.join(rootDir, material.storagePath!))).toBe(true);
    expect(material.storagePath).toMatch(/^materials\/_uploads\//);

    const { userMessage, task } = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: project.id,
      content: '按附件开工',
      attachments: [{ materialId: material.id, name: material.name, kind: material.kind, size: 18 }],
    });

    expect(userMessage.attachments).toHaveLength(1);
    expect(userMessage.attachments[0]).toMatchObject({ materialId: material.id, name: '需求草稿.md' });
    expect(listMessages(db, 'project', project.id)[0]!.attachments).toHaveLength(1);

    const dispatched = listTasks(db, project.id)[0]!;
    expect(dispatched.inputProtocol.content as string).toContain('【用户附件】');
    expect(dispatched.inputProtocol.content as string).toContain(material.storagePath!);
    expect(task!.id).toBe(dispatched.id);
  });

  it('附件素材不属于本项目 → 拒绝', () => {
    const r1 = createNovelCompany(db, { name: 'co1' });
    const p1 = createProject(db, { companyId: r1.company.id, name: 'p1', rootDir: tempProjectRoot('b'), firstAgentId: r1.agents.lead.id, initialState: 'active' });
    const r2 = createNovelCompany(db, { name: 'co2' });
    const p2 = createProject(db, { companyId: r2.company.id, name: 'p2', rootDir: tempProjectRoot('c'), firstAgentId: r2.agents.lead.id, initialState: 'active' });

    const foreign = importUploadedFile(db, p2.id, { data: Buffer.from('x'), originalName: 'x.txt' });
    expect(() =>
      postUserMessage(db, { scopeKind: 'project', scopeId: p1.id, content: 'hi', attachments: [{ materialId: foreign.id, name: 'x.txt', kind: 'document', size: 1 }] }),
    ).toThrow(/不属于|不存在|素材/);
  });

  it('不存在的附件素材 → 明确报错', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, { companyId: r.company.id, name: 'p', rootDir: tempProjectRoot('d'), firstAgentId: r.agents.lead.id, initialState: 'active' });
    expect(() =>
      postUserMessage(db, { scopeKind: 'project', scopeId: project.id, content: 'hi', attachments: [{ materialId: 'mat_missing', name: 'ghost.png', kind: 'image', size: 10 }] }),
    ).toThrow('附件素材不存在');
  });
});
