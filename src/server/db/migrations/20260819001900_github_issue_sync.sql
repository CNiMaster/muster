-- 整改计划 Part2 批次 6：GitHub Issues 自动化——幂等记账表（同一 repo+number 只派发一次）。
CREATE TABLE github_issue_sync (
  id         TEXT PRIMARY KEY,
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id    TEXT,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched','triaged','resolved','ignored')),
  synced_at  TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo, number)
);
CREATE INDEX idx_github_issue_sync_project ON github_issue_sync(project_id);
