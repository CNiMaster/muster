#!/usr/bin/env node
/**
 * 人设使用热度复排名（W4 收口批，2026-08-30）。
 *
 * 三路只读证据合成 Top 专家清单，供真实使用数据积累后刷新知识包优先级
 * （docs/persona-knowledge-pack.md 的「待真实数据复排名」流程入口）：
 *   ① task.persona_id 穿戴计数（终态任务为主，附进行中）
 *   ② specialist_pool.use_count 汇总（常驻专家被借用热度）
 *   ③ blueprint.staffing_json 出现频次（打法绑定面）
 * 只读查询（mode=ro），不写任何库。用法：node scripts/persona-usage-rank.mjs [N]（默认 20）
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = process.env.MUSTER_HOME ?? path.join(os.homedir(), '.muster');
const dbPath = path.join(home, 'muster.db');
if (!existsSync(dbPath)) {
  console.error(`未找到库文件：${dbPath}（MUSTER_HOME 可指定）`);
  process.exit(1);
}
const TOP_N = Number(process.argv[2] ?? 20);

// node:sqlite 尚不支持 URI 只读模式字符串，用只读打开方式
const db = new DatabaseSync(dbPath, { readOnly: true });

const wear = db.prepare(`
  SELECT persona_id AS id, COUNT(*) AS n FROM task
  WHERE persona_id IS NOT NULL GROUP BY persona_id`).all();
const terminalWear = db.prepare(`
  SELECT persona_id AS id, COUNT(*) AS n FROM task
  WHERE persona_id IS NOT NULL AND state IN ('completed','failed','cancelled')
  GROUP BY persona_id`).all();
const pool = db.prepare(`
  SELECT persona_id AS id, SUM(use_count) AS n FROM specialist_pool
  GROUP BY persona_id`).all();
const staffing = db.prepare(`
  SELECT json_extract(j.value, '$.personaId') AS pid, COUNT(*) AS n
  FROM blueprint, json_each(blueprint.staffing_json) j
  WHERE json_extract(j.value, '$.personaId') IS NOT NULL
  GROUP BY pid`).all();

const byId = (rows) => new Map(rows.map((r) => [r.id, r.n]));
const w = byId(wear), tw = byId(terminalWear), pl = byId(pool), st = byId(staffing);
const ids = new Set([...w.keys(), ...pl.keys(), ...st.keys()]);

const rows = [...ids].map((id) => ({
  id,
  wear: w.get(id) ?? 0,
  terminal: tw.get(id) ?? 0,
  pool: pl.get(id) ?? 0,
  staffing: st.get(id) ?? 0,
  // 合成分：穿戴(×3，终态另计权重) + 借用(×2) + 打法绑定(×1)
  score: (w.get(id) ?? 0) * 3 + (tw.get(id) ?? 0) * 2 + (pl.get(id) ?? 0) * 2 + (st.get(id) ?? 0),
})).sort((a, b) => b.score - a.score).slice(0, TOP_N);

console.log(`人设使用热度 Top ${TOP_N}（${dbPath}，只读查询）`);
console.log('persona_id\t合成分\t穿戴\t其中终态\t专家池借用\t蓝图绑定');
for (const r of rows) {
  console.log(`${r.id}\t${r.score}\t${r.wear}\t${r.terminal}\t${r.pool}\t${r.staffing}`);
}
if (rows.length === 0) {
  console.log('（暂无使用数据——真实使用开始后重跑本脚本刷新优先级）');
}
