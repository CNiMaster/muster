-- 批次三第二片：项目任务清单（用户手写清单 → 逐项执行，验收 PASS 自动解锁下一项）。
-- cursor = 当前执行到的条目下标；state active/done。条目任务带 acceptanceCriteria 走既有验收链，
-- PASS → advanceChecklist 派下一条；全部完成 → done + 项目群播报。
CREATE TABLE project_task_checklist (
  project_task_id TEXT PRIMARY KEY REFERENCES project_task(id) ON DELETE CASCADE,
  items_json      TEXT NOT NULL,
  cursor          INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','done')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
