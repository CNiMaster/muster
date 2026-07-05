-- 持久化定时触发器的下一次执行时间，保证重启后继续调度且不会重复派发。
ALTER TABLE trigger ADD COLUMN next_run_at TEXT;
ALTER TABLE trigger ADD COLUMN last_fired_at TEXT;

CREATE INDEX idx_trigger_schedule_due
  ON trigger(enabled, kind, next_run_at)
  WHERE enabled = 1 AND kind = 'schedule';
