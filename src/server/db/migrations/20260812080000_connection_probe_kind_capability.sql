-- 修复 connection_probe.kind 的 CHECK 约束（阶段二任务 2.3）：
-- 原 0024 迁移约束只允许 ('connectivity','model')，而能力探针（kind='capability'）
-- 插入时会违反约束导致失败。SQLite 不支持修改列级 CHECK，需重建表。
CREATE TABLE connection_probe_new (
  id TEXT PRIMARY KEY,
  executor_profile_id TEXT NOT NULL REFERENCES executor_profile(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','testing','connected','failed')),
  classification TEXT,
  version TEXT,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'connectivity' CHECK (kind IN ('connectivity','model','capability')),
  model TEXT,
  capability_json TEXT
);

INSERT INTO connection_probe_new (id, executor_profile_id, cache_key, status, classification, version, stdout, stderr, duration_ms, started_at, completed_at, created_at, kind, model, capability_json)
SELECT id, executor_profile_id, cache_key, status, classification, version, stdout, stderr, duration_ms, started_at, completed_at, created_at, kind, model, capability_json
FROM connection_probe;

DROP TABLE connection_probe;
ALTER TABLE connection_probe_new RENAME TO connection_probe;
CREATE INDEX idx_connection_probe_cache ON connection_probe(executor_profile_id,cache_key,status,completed_at);
