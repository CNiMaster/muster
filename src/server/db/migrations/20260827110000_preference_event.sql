-- 选择闭环专项 S1（spec 2026-08-27-selection-loop）：条件偏好事件。
-- 定案：偏好必须以 (用户×意图×路线) 三元组落库，禁止裸 (用户, 工具)——防"需求变了被
-- 误读成偏好变了"。纠偏二分：need-statement 只更新条件画像（不否定既有偏好）；
-- route-complaint 才影响口碑。source 区分用户显式选择与三态高置信静默（防 auto 污染画像）。
CREATE TABLE IF NOT EXISTS preference_event (
  id                TEXT PRIMARY KEY,
  profile_id        TEXT NOT NULL,
  intent_tag        TEXT NOT NULL,
  route             TEXT NOT NULL,
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  source            TEXT NOT NULL CHECK (source IN ('user', 'auto')),
  kind              TEXT NOT NULL DEFAULT 'route-choice'
                    CHECK (kind IN ('route-choice', 'need-statement', 'route-complaint')),
  task_id           TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preference_event_lookup ON preference_event(profile_id, intent_tag, created_at);
