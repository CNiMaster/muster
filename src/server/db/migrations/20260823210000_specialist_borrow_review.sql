-- 批次 J：专家借调留痕 + 记忆盘点（盘点制非过期制）
-- specialist_borrow：跨项目借调流水（归还=记账非状态迁移——专家默认不排队不锁定）。
CREATE TABLE specialist_borrow (
  id TEXT PRIMARY KEY,
  from_project_id TEXT NOT NULL,
  to_project_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  returned_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_specialist_borrow_specialist ON specialist_borrow(specialist_id, created_at);
CREATE INDEX idx_specialist_borrow_to ON specialist_borrow(to_project_id, created_at);

-- specialist_review：人事盘点清单（归档触发待处置 / 定期 idle 盘点；处置=用户拍板四动作）。
CREATE TABLE specialist_review (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('archive-disposition','idle-inventory')),
  project_id TEXT,
  specialist_id TEXT NOT NULL,
  agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  suggestion TEXT NOT NULL,
  resolution TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_specialist_review_status ON specialist_review(status, kind, created_at);
