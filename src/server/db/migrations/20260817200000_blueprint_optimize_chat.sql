-- 蓝图独立优化对话（2026-08-17 定案：退役整体体检，每蓝图一条 AI 优化会话线）。
-- 会话产出结构化提案落既有 blueprint_optimization_item（pending），采纳/忽略沿用版本化落地链路。
CREATE TABLE blueprint_optimize_chat (
  id TEXT PRIMARY KEY,
  blueprint_id TEXT NOT NULL REFERENCES blueprint(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_boc_blueprint ON blueprint_optimize_chat(blueprint_id, created_at);
