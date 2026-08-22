-- H9b 安全审查留档：每条经权限 guard 的判定（命令/模式/结论/理由）——复盘可追责。
CREATE TABLE IF NOT EXISTS permission_audit (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  project_id TEXT,
  action TEXT NOT NULL,
  command TEXT,
  mode TEXT,
  verdict TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permission_audit_task ON permission_audit(task_id);
CREATE INDEX IF NOT EXISTS idx_permission_audit_project ON permission_audit(project_id);
