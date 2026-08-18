-- 公司退役批次 D Task6：company 瘦身并 RENAME 为 workbench 单例表。
CREATE TABLE workbench_new (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'novel',
  state        TEXT NOT NULL DEFAULT 'off'
               CHECK (state IN ('off','online','draining','review_paused')),
  charter      TEXT NOT NULL DEFAULT '',
  contract_json TEXT NOT NULL DEFAULT '{}',
  first_agent_id TEXT,                                -- 活列:蜂群放蜂请示/审批升级,本批保留(见 Global Constraints)
  review_mode  TEXT NOT NULL DEFAULT 'blocking',      -- 活列:审批门控,本批保留
  shutdown_paused INTEGER NOT NULL DEFAULT 0,         -- 优雅关机标记(20260814000000),状态机在用
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

INSERT INTO workbench_new (id, name, kind, state, charter, contract_json, first_agent_id, review_mode, shutdown_paused, created_at, updated_at)
  SELECT id, name, kind, state, charter, contract_json, first_agent_id, review_mode, shutdown_paused, created_at, updated_at FROM company;

DROP TABLE company;
ALTER TABLE workbench_new RENAME TO workbench;
