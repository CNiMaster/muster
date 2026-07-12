CREATE TABLE project_task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','completed','archived')),
  completed_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, seq)
);

CREATE INDEX idx_project_task_state ON project_task(project_id, state, updated_at);

CREATE TABLE project_task_thread (
  id TEXT PRIMARY KEY,
  project_task_id TEXT NOT NULL REFERENCES project_task(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES agent_definition(id) ON DELETE CASCADE,
  executor_profile_id TEXT REFERENCES executor_profile(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'primary' CHECK (kind IN ('primary','mirror')),
  root_thread_id TEXT REFERENCES project_task_thread(id) ON DELETE CASCADE,
  vendor_session_id TEXT,
  previous_vendor_session_id TEXT,
  state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','running','waiting','paused','failed','archived')),
  health_json TEXT NOT NULL DEFAULT '{}',
  handoff_json TEXT NOT NULL DEFAULT '{}',
  run_count INTEGER NOT NULL DEFAULT 0,
  transcript_bytes INTEGER NOT NULL DEFAULT 0,
  compaction_count INTEGER NOT NULL DEFAULT 0,
  last_compaction_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_project_task_thread_primary
  ON project_task_thread(project_task_id, employee_id)
  WHERE kind='primary';
CREATE INDEX idx_project_task_thread_task ON project_task_thread(project_task_id, state);

ALTER TABLE task ADD COLUMN project_task_id TEXT REFERENCES project_task(id) ON DELETE CASCADE;
ALTER TABLE task ADD COLUMN assignee_task_thread_id TEXT REFERENCES project_task_thread(id) ON DELETE SET NULL;

INSERT INTO project_task (id, project_id, seq, title, brief, state, completed_at, archived_at, created_at, updated_at)
SELECT 'pt_legacy_' || t.id, t.project_id,
       ROW_NUMBER() OVER (PARTITION BY t.project_id ORDER BY t.seq),
       t.title, '',
       CASE WHEN t.state IN ('completed','cancelled') THEN 'completed' ELSE 'active' END,
       t.completed_at, NULL, t.created_at, t.updated_at
FROM task t
WHERE t.id = COALESCE(t.root_task_id, t.id);

UPDATE task
SET project_task_id = 'pt_legacy_' || COALESCE(root_task_id, id)
WHERE project_task_id IS NULL;

CREATE INDEX idx_task_project_task ON task(project_task_id, state, seq);
