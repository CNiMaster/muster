-- 双 Loop 自改进系统（P3）：反思闭环队列。
-- 目的：把"task 到达终态 → 离线复盘 → 经验沉淀进 memory"这条回路显式化。
-- 每条记录是一次待执行/已执行的反思；由 coordinator.tick() 在 pumpAll 之后离线消化（非阻塞）。
--
-- 设计原则：
-- - task_id UNIQUE：保证 enqueue 幂等（即使多个终态触发点命中同一 task 也只入队一次）。
-- - status 状态机：pending（待消化）→ running（消化中）→ done/skipped/error。
-- - signal：标记反思信号来源（completed/blocked-safety/failed/rework/circuit-break-rollback），
--   兼作反思 loop 的根因分类标签（喂给 prompt 与归因分析）。
-- - context_snapshot：终态时打的最小快照（goal/attempts/failureCount/interruptionCount/acceptanceMet/error），
--   让反思推理不必回查整条执行链。
-- - candidate_id：若沉淀为 memory_candidate，记录关联 id；skipped（如去重命中）时为 NULL。
CREATE TABLE IF NOT EXISTS task_reflection (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL UNIQUE REFERENCES task(id) ON DELETE CASCADE,
  company_id       TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  profile_id       TEXT,
  outcome          TEXT NOT NULL,
  signal           TEXT NOT NULL,
  context_snapshot TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','done','skipped','error')),
  candidate_id     TEXT,
  reflection_text  TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL,
  reflected_at     TEXT
);

-- drain 消化队列按此索引批量取 pending。
CREATE INDEX idx_task_reflection_status ON task_reflection(status, created_at);
-- 按项目回看反思历史。
CREATE INDEX idx_task_reflection_project ON task_reflection(project_id, created_at);
