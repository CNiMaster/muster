-- 运营监察告警持久化（阶段一任务 1.3）：
-- Inspector 定时自动运行后把非 ok 的建议落库，前端可查、可标记处理；
-- 高严重度（stuck/absence）同时上报第一负责人。
CREATE TABLE IF NOT EXISTS inspector_alert (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL,                            -- congestion/absence/loop/stuck/suggest_mirror
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',       -- high/medium
  target_agent_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inspector_alert_project ON inspector_alert(project_id, resolved_at);
