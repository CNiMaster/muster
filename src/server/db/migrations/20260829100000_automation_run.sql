-- 自动化中心批次1（执行历史）：automation_run——每次到点执行一条记录，循环任务历史不再被 last_result 互相覆盖。
-- 保留策略由应用层惰性 prune（每条自动化只留最近 100 条），不建触发器。
CREATE TABLE automation_run (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automation(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('ok','failed','skipped')),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  result        TEXT
);
CREATE INDEX idx_automation_run_recent ON automation_run(automation_id, started_at DESC);
