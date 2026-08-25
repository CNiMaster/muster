-- safety: rebuild
-- 批次 0（capability parity 2026-08-26）：memory scope 'skill' → 'craft'，一次性改净不留兼容双值。
-- 缘由：该维度语义是「挂人设的手艺经验」（persona_key 池，同款人设共享）+「员工个人手艺」，
-- 与技能库/能力商城 kind='skill'（技能包概念）撞名。本地单机无外部契约消费者，保留双读=歧义永久化。
--
-- 顺带收口结构漂移：主用库 memory_entry 为 0017 老形态+后续 ALTER（含 confidence/author 死列、
-- 缺代码 INSERT 所需 version/source_candidate_id——0 行数据所以从未触发），备份库为 company_drop
-- 重建形态。本次统一重建到 code-shaped 终态；SELECT 仅取两库共有列，不依赖漂移差异列（entry 的
-- version/source_candidate_id 取默认值；candidate 的 supersedes_entry_id 取默认 NULL——备份库尚未
-- 迁移到 20260824100000，该列可能缺失；两库该两表当前均 0 行，搬运无实害）。
-- memory_fts 为独立 FTS5 表（无触发器/外部内容依赖）、
-- memory_injection/memory_version 不引用重建对象，均不受影响。
-- 列清单对账来源：主用库与备份库 sqlite_master（2026-08-26）+ memory.ts EntryRow/CandidateRow。

CREATE TABLE _memory_entry_new (
  id                 TEXT PRIMARY KEY,
  profile_id         TEXT NOT NULL,
  scope              TEXT NOT NULL CHECK (scope IN ('personal','workspace','project','craft')),
  project_id         TEXT,
  content            TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  state              TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','locked','superseded','deleted')),
  can_influence      INTEGER NOT NULL DEFAULT 0 CHECK (can_influence IN (0,1)),
  source_candidate_id TEXT,
  expires_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  fingerprint        TEXT,
  persona_key        TEXT,
  hit_count          INTEGER NOT NULL DEFAULT 0,
  vote_count         INTEGER NOT NULL DEFAULT 0,
  adv_sum            REAL NOT NULL DEFAULT 0,
  cause              TEXT,
  tags_json          TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (profile_id) REFERENCES agent_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE,
  FOREIGN KEY (source_candidate_id) REFERENCES memory_candidate(id) ON DELETE SET NULL
);
INSERT INTO _memory_entry_new (
  id, profile_id, scope, project_id, content, state, can_influence,
  expires_at, created_at, updated_at, fingerprint, persona_key,
  hit_count, vote_count, adv_sum, cause, tags_json
) SELECT
  id, profile_id, CASE scope WHEN 'skill' THEN 'craft' ELSE scope END, project_id, content, state, can_influence,
  expires_at, created_at, updated_at, fingerprint, persona_key,
  hit_count, vote_count, adv_sum, cause, tags_json
FROM memory_entry;
DROP TABLE memory_entry;
ALTER TABLE _memory_entry_new RENAME TO memory_entry;
CREATE INDEX idx_memory_entry_scope ON memory_entry(profile_id, scope, project_id, state);

CREATE TABLE _memory_candidate_new (
  id                 TEXT PRIMARY KEY,
  profile_id         TEXT NOT NULL,
  scope              TEXT NOT NULL CHECK (scope IN ('personal','workspace','project','craft')),
  project_id         TEXT,
  content            TEXT NOT NULL,
  source_task_id     TEXT,
  source_message_id  TEXT,
  author             TEXT NOT NULL,
  confidence         REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  can_influence      INTEGER NOT NULL DEFAULT 0 CHECK (can_influence IN (0,1)),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  quarantine_reason  TEXT,
  expires_at         TEXT,
  reviewed_by        TEXT,
  reviewed_at        TEXT,
  created_at         TEXT NOT NULL,
  fingerprint        TEXT,
  persona_key        TEXT,
  cause              TEXT,
  tags_json          TEXT NOT NULL DEFAULT '[]',
  supersedes_entry_id TEXT NULL,
  FOREIGN KEY (profile_id) REFERENCES agent_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
INSERT INTO _memory_candidate_new (
  id, profile_id, scope, project_id, content,
  source_task_id, source_message_id, author, confidence, can_influence, status,
  quarantine_reason, expires_at, reviewed_by, reviewed_at, created_at,
  fingerprint, persona_key, cause, tags_json
) SELECT
  id, profile_id, CASE scope WHEN 'skill' THEN 'craft' ELSE scope END, project_id, content,
  source_task_id, source_message_id, author, confidence, can_influence, status,
  quarantine_reason, expires_at, reviewed_by, reviewed_at, created_at,
  fingerprint, persona_key, cause, tags_json
FROM memory_candidate;
DROP TABLE memory_candidate;
ALTER TABLE _memory_candidate_new RENAME TO memory_candidate;
