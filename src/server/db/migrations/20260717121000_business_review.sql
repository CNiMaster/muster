-- 业务产物审批：素材达标 / 成品可用 / 人物关系 / 功法等。
-- 与 permission_approval（CLI 命令审批）不同：这是业务产物的异步审批。
-- 打回 = 派发新 Task（不回原会话），解决上下文混乱。
CREATE TABLE business_review (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  employee_id TEXT NOT NULL,
  review_kind TEXT NOT NULL,          -- material|artifact|character|skill|relationship|plot|custom
  subject_id TEXT NOT NULL,           -- 被审对象 id（素材/成品/人物档案 id）
  subject_snapshot_json TEXT NOT NULL, -- 审批时快照（防对象后续被改）
  title TEXT NOT NULL,
  summary TEXT,                       -- 一句话摘要
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|changes_requested
  feedback TEXT,
  decided_by TEXT,
  decided_at TEXT,
  rework_task_id TEXT,                -- 打回时派发的新 Task id
  created_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id)
);
CREATE INDEX idx_business_review_company_status ON business_review(company_id, status);
CREATE INDEX idx_business_review_task ON business_review(task_id);
