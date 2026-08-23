-- safety: rebuild
-- 指挥系统批次1：定时自动化补齐。
-- 1) 每天 N 点时刻语义：schedule_kind('interval'|'daily') + time_of_day('HH:mm') + timezone
--    （daily 行的 interval_ms 固定 86400000，既满足原 CHECK 又作为兜底推进步长）
-- 2) 公司级触发器：project_id 放开为可空 + 新增 company_id（事件触发器仍限项目级，由代码保证）
-- 3) 防叠跑：last_task_id 记录上次派发的 Task，下次到期时若其仍 active 则跳过
-- SQLite 无法改列约束，重建表并迁移数据。

CREATE TABLE trigger_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES project(id) ON DELETE CASCADE,
  company_id  TEXT REFERENCES company(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('event','schedule')),
  event_name  TEXT,
  cron_expr   TEXT,
  interval_ms INTEGER,
  schedule_kind TEXT NOT NULL DEFAULT 'interval' CHECK (schedule_kind IN ('interval','daily')),
  time_of_day TEXT,
  timezone    TEXT,
  template_json TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_task_id TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  next_run_at TEXT,
  last_fired_at TEXT,
  CHECK ((kind='event' AND event_name IS NOT NULL) OR (kind='schedule' AND interval_ms IS NOT NULL)),
  CHECK (project_id IS NOT NULL OR company_id IS NOT NULL)
);

INSERT INTO trigger_new
  (id, project_id, company_id, kind, event_name, cron_expr, interval_ms,
   schedule_kind, time_of_day, timezone, template_json, enabled, last_task_id,
   created_at, updated_at, next_run_at, last_fired_at)
SELECT
  id, project_id, NULL, kind, event_name, cron_expr, interval_ms,
  'interval', NULL, NULL, template_json, enabled, NULL,
  created_at, updated_at, next_run_at, last_fired_at
FROM trigger;

DROP TABLE trigger;
ALTER TABLE trigger_new RENAME TO trigger;

-- 重建 0004 的到期部分索引
CREATE INDEX idx_trigger_schedule_due
  ON trigger(enabled, kind, next_run_at)
  WHERE enabled = 1 AND kind = 'schedule';

CREATE INDEX idx_trigger_company
  ON trigger(company_id)
  WHERE company_id IS NOT NULL;
