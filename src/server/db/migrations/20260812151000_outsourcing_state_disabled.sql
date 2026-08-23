-- safety: rebuild
-- spec 2026-08-12-subagent-observability B3：允许 outsourcing_contract.state = 'auto_accept_disabled'。
-- 自动接受连续失败达上限后转入此终态，停止空转（详见 outsourcing-contract.ts revertAcceptToPending）。
-- SQLite 不支持就地修改列的 CHECK 约束，需按标准模式重建表（建新表→复制→删旧→改名→重建索引）。
PRAGMA foreign_keys = OFF;

CREATE TABLE outsourcing_contract_new (
  id                          TEXT PRIMARY KEY,
  source_company_id           TEXT NOT NULL REFERENCES company(id),
  target_company_id           TEXT NOT NULL REFERENCES company(id),
  source_project_id           TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  source_task_id              TEXT REFERENCES task(id) ON DELETE SET NULL,
  outsourced_task_id          TEXT REFERENCES task(id) ON DELETE SET NULL,
  title                       TEXT NOT NULL,
  brief                       TEXT NOT NULL,
  acceptance_criteria_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acceptance_criteria_json)),
  required_capability_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_capability_ids_json)),
  deliverable_dir             TEXT,
  readonly_refs_json          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(readonly_refs_json)),
  state                       TEXT NOT NULL DEFAULT 'pending'
                                CHECK (state IN ('pending','accepted','in_progress','delivered','reviewing','changes_requested','completed','rejected','cancelled','auto_accept_disabled')),
  vendor_liaison_agent_id     TEXT REFERENCES agent_definition(id) ON DELETE SET NULL,
  dispatcher_agent_id         TEXT REFERENCES agent_definition(id) ON DELETE SET NULL,
  feedback_json               TEXT,
  revision_round              INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  auto_accept_attempt_count   INTEGER NOT NULL DEFAULT 0,
  auto_accept_after_at        TEXT,
  auto_accept_max_attempts    INTEGER NOT NULL DEFAULT 8
);

INSERT INTO outsourcing_contract_new (
  id, source_company_id, target_company_id, source_project_id, source_task_id, outsourced_task_id,
  title, brief, acceptance_criteria_json, required_capability_ids_json, deliverable_dir, readonly_refs_json,
  state, vendor_liaison_agent_id, dispatcher_agent_id, feedback_json, revision_round, created_at, updated_at,
  auto_accept_attempt_count, auto_accept_after_at, auto_accept_max_attempts
)
SELECT
  id, source_company_id, target_company_id, source_project_id, source_task_id, outsourced_task_id,
  title, brief, acceptance_criteria_json, required_capability_ids_json, deliverable_dir, readonly_refs_json,
  state, vendor_liaison_agent_id, dispatcher_agent_id, feedback_json, revision_round, created_at, updated_at,
  auto_accept_attempt_count, auto_accept_after_at, auto_accept_max_attempts
FROM outsourcing_contract;

DROP TABLE outsourcing_contract;
ALTER TABLE outsourcing_contract_new RENAME TO outsourcing_contract;

CREATE INDEX IF NOT EXISTS idx_outsourcing_source ON outsourcing_contract(source_company_id, state);
CREATE INDEX IF NOT EXISTS idx_outsourcing_target ON outsourcing_contract(target_company_id, state);
CREATE INDEX IF NOT EXISTS idx_outsourcing_outsourced_task ON outsourcing_contract(outsourced_task_id);

PRAGMA foreign_key_check;
PRAGMA foreign_keys = ON;
