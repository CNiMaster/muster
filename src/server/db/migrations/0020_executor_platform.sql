CREATE TABLE executor_profile (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  manifest_id        TEXT NOT NULL,
  manifest_version   INTEGER NOT NULL,
  config_json        TEXT NOT NULL DEFAULT '{}',
  credential_ref_json TEXT NOT NULL DEFAULT '{}',
  install_json       TEXT NOT NULL DEFAULT '{}',
  concurrency_mode   TEXT NOT NULL CHECK (concurrency_mode IN ('parallel', 'profile-serial', 'global-serial')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE execution_run (
  id                       TEXT PRIMARY KEY,
  executor_profile_id      TEXT NOT NULL REFERENCES executor_profile(id) ON DELETE RESTRICT,
  employee_id              TEXT NOT NULL,
  project_id               TEXT NOT NULL,
  task_id                  TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('created', 'running', 'completed', 'failed', 'cancelled')),
  manifest_snapshot_json   TEXT NOT NULL,
  profile_snapshot_json    TEXT NOT NULL,
  started_at               TEXT,
  finished_at              TEXT,
  created_at               TEXT NOT NULL
);

CREATE INDEX idx_execution_run_task ON execution_run(task_id, created_at);
CREATE INDEX idx_execution_run_profile_status ON execution_run(executor_profile_id, status, created_at);

ALTER TABLE company_employee ADD COLUMN executor_profile_id TEXT REFERENCES executor_profile(id);

-- 为升级用户保留原有员工执行器语义：每个既有任职生成一个固定 Profile。
INSERT INTO executor_profile (
  id, name, manifest_id, manifest_version, config_json, credential_ref_json,
  install_json, concurrency_mode, created_at, updated_at
)
SELECT
  'ep_legacy_' || ad.id,
  ad.name || ' 的兼容执行器',
  CASE json_extract(ad.executor_json, '$.provider')
    WHEN 'openai' THEN 'openai-compatible-api'
    WHEN 'gemini' THEN 'gemini-api'
    ELSE 'claude-code-cli'
  END,
  1,
  json_remove(ad.executor_json, '$.apiKeyEnv'),
  CASE WHEN json_extract(ad.executor_json, '$.apiKeyEnv') IS NOT NULL
    THEN json_object('kind','env','reference',json_extract(ad.executor_json, '$.apiKeyEnv'))
    ELSE '{}'
  END,
  json_object('managed',0,'source','legacy-settings'),
  'parallel',
  ad.created_at,
  ad.updated_at
FROM agent_definition ad;

UPDATE company_employee
SET executor_profile_id = 'ep_legacy_' || legacy_agent_id
WHERE executor_profile_id IS NULL;
