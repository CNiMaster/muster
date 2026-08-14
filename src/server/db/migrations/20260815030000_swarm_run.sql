-- 指挥系统批次2 W1：蜂群记账。
-- swarm_run：一群的限额快照（创建时从系统设置定格）+ 实时计数（单一记账咽喉 completeTask/failTask/cancelTask 更新）。
-- task.swarm_id/swarm_depth：成员归属与树深度（深度/宽度/总量限额的判定依据）。
CREATE TABLE swarm_run (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  root_task_id TEXT NOT NULL,
  synthesis_task_id TEXT,
  goal        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','aborted','failed')),
  max_depth   INTEGER NOT NULL,
  max_width   INTEGER NOT NULL,
  max_nodes   INTEGER NOT NULL,
  budget_usd  REAL NOT NULL,
  nodes_total INTEGER NOT NULL DEFAULT 0,
  nodes_done  INTEGER NOT NULL DEFAULT 0,
  nodes_failed INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX idx_swarm_run_company ON swarm_run(company_id);
CREATE INDEX idx_swarm_run_status ON swarm_run(status);
CREATE INDEX idx_swarm_run_root_task ON swarm_run(root_task_id);

ALTER TABLE task ADD COLUMN swarm_id TEXT REFERENCES swarm_run(id) ON DELETE SET NULL;
ALTER TABLE task ADD COLUMN swarm_depth INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_task_swarm ON task(swarm_id);
