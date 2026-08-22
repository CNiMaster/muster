/**
 * 侧边辅助对话（批次 I-b）集成：域往返（user+assistant 落库/负责人 author/降级文案/清空/历史窗口）
 * + API GET/POST/DELETE（空 content 400）。
 * 测试环境无模型凭据 → callLlm 必失败 → assistant=降级指引文案（确定性断言锚点）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { sideChatAnswerer, postSideMessage, listSideMessages, clearSideChat } from '../../src/server/domain/side-chat';
import { sideRouter } from '../../src/server/api/side';

let tdb: ReturnType<typeof makeTestDb>;
let server: http.Server;
let base: string;

beforeEach(async () => {
  tdb = makeTestDb();
  setDbForTest(tdb.db);
  restoreWorkbench(tdb.db, { id: 'wb_side', name: '默认工作台' });

  const app = express();
  app.use(express.json());
  app.use('/api/side', sideRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ error: { code: 'test', message: (err as Error).message } });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closeDb();
});

describe('side-chat 域（批次 I-b）', () => {
  it('postSideMessage：user+assistant 两条落库；无凭据环境 assistant=降级指引；author=负责人', async () => {
    const lead = createAgent(tdb.db, { companyId: 'wb_side', name: '李负责人', role: 'lead' });
    tdb.db.prepare('UPDATE workbench SET first_agent_id=? WHERE id=?').run(lead.id, 'wb_side');
    const answerer = sideChatAnswerer(tdb.db);
    expect(answerer.agentId).toBe(lead.id);

    const { user, assistant } = await postSideMessage(tdb.db, '这个报错什么意思？');
    expect(user.role).toBe('user');
    expect(user.content).toContain('报错');
    expect(assistant.author).toBe(lead.id);
    expect(assistant.content).toContain('侧边对话暂不可用'); // 无凭据降级
    expect(listSideMessages(tdb.db)).toHaveLength(2);
  });

  it('答复者兜底：无 firstAgentId 时懒确保固定员工', () => {
    const answerer = sideChatAnswerer(tdb.db);
    expect(answerer.agentId).toBeTruthy();
    const agent = tdb.db.prepare('SELECT role FROM agent_definition WHERE id=?').get(answerer.agentId) as { role: string };
    expect(agent.role).toBe('lead');
  });

  it('历史窗口：连发多轮后 listSideMessages 只保留 limit 条（域内转录截 12 条）', async () => {
    for (let i = 0; i < 10; i++) await postSideMessage(tdb.db, `问题${i}`);
    expect(listSideMessages(tdb.db)).toHaveLength(20); // 每轮 2 条（user+assistant）
    expect(listSideMessages(tdb.db, 5)).toHaveLength(5); // limit 生效
  });

  it('clearSideChat 清空且只清 side（不碰 workbench/project 消息）', async () => {
    await postSideMessage(tdb.db, 'hi');
    tdb.db.prepare("INSERT INTO conversation_message (id, scope_kind, scope_id, author, role, content, ref_task_id, created_at, attachments_json, options_json) VALUES ('cm_keep','workbench','wb_side','user','user','x',NULL,?, '[]','{}')").run(new Date().toISOString());
    const { deleted } = clearSideChat(tdb.db);
    expect(deleted).toBe(2);
    expect(listSideMessages(tdb.db)).toHaveLength(0);
    const keep = tdb.db.prepare("SELECT COUNT(*) n FROM conversation_message WHERE id='cm_keep'").get() as { n: number };
    expect(keep.n).toBe(1);
  });

  it('空 content 抛 VALIDATION', async () => {
    await expect(postSideMessage(tdb.db, '  ')).rejects.toThrow('消息内容不能为空');
  });
});

describe('side-chat API（批次 I-b）', () => {
  it('GET 空 → []；POST → 201 双消息；DELETE → 清空', async () => {
    const empty = await fetch(`${base}/api/side/messages`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const post = await fetch(`${base}/api/side/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '给个思路' }),
    });
    expect(post.status).toBe(201);
    const body = (await post.json()) as { user: { role: string }; assistant: { content: string } };
    expect(body.user.role).toBe('user');
    expect(body.assistant.content).toContain('侧边对话暂不可用');

    const del = await fetch(`${base}/api/side/messages`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: number }).deleted).toBe(2);
  });

  it('POST 空 content → 400', async () => {
    const post = await fetch(`${base}/api/side/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    });
    expect(post.status).toBe(400);
  });
});
