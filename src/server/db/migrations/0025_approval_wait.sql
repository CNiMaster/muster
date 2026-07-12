ALTER TABLE task ADD COLUMN wait_state TEXT CHECK (wait_state IS NULL OR wait_state='waiting_approval');
ALTER TABLE permission_approval ADD COLUMN execution_run_id TEXT;
ALTER TABLE permission_approval ADD COLUMN project_task_thread_id TEXT;
ALTER TABLE permission_approval ADD COLUMN executor_profile_id TEXT;
ALTER TABLE permission_approval ADD COLUMN expires_at TEXT;
ALTER TABLE permission_approval ADD COLUMN recovery_json TEXT NOT NULL DEFAULT '{}';
