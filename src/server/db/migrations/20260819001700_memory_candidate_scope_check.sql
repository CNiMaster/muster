-- 整改批次 4（修正定位）：scope CHECK 漂移在 memory_candidate 表（memory_entry 已在早前重建中带 'workspace'）——
-- TS 枚举 'workspace' 落候选必违约。按终态 schema 逐列重建（复盘 0002 规程：列清单自 sqlite_master 导出对账）。
CREATE TABLE _memory_candidate_new (
  id                 TEXT PRIMARY KEY,
  profile_id         TEXT NOT NULL,
  scope              TEXT NOT NULL CHECK (scope IN ('personal','workspace','project','skill')),
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
  FOREIGN KEY (profile_id) REFERENCES agent_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
INSERT INTO _memory_candidate_new SELECT * FROM memory_candidate;
DROP TABLE memory_candidate;
ALTER TABLE _memory_candidate_new RENAME TO memory_candidate;
