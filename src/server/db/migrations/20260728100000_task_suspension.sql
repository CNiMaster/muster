-- Task 挂起统一记录（借鉴"挂起即一等状态、需打快照可恢复"的思想，结构重新设计）。
-- 目的：把原先散落在 task.state='waiting_input' / wait_state='waiting_approval' / clarification_rounds
-- 三处的"单个 task 被外部决策暂停"语义，统一以只读元数据表记录，
-- 不改动 task 状态机本身（waiting_input 仍是一等 TaskState，活跃态查询不受影响）。
--
-- 设计原则：
-- - 纯加法。不动 task 表的 CHECK 约束、不动 ALLOWED_TRANSITIONS、不动活跃态枚举。
-- - task_suspension 只记录"为什么停 / 关联哪个审批 / 恢复所需最小快照"，是查询与审计层。
-- - 恢复动作仍由各业务域（approval / business-review / task.answerClarification）各自驱动，
--   避免把三种不同语义的恢复硬塞进一个函数。

CREATE TABLE task_suspension (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  -- 借鉴"统一挂起原语"的思路，但用 muster 自己的命名与分类：
  kind             TEXT NOT NULL CHECK (kind IN ('approval', 'review', 'clarification')),
  -- 人可读原因（用于审计与看板展示）。
  reason           TEXT,
  -- 关联的外部记录 id：permission_approval.id / business_review.id；clarification 时为 NULL。
  ref_id           TEXT,
  -- 恢复所需最小上下文快照（JSON）。借鉴"挂起时打快照以便断点续跑"的思想，
  -- 但只存恢复真正需要的字段（如 vendorSessionId、reviewKind、subjectSnapshot），结构由各业务域自定。
  resume_snapshot_json  TEXT NOT NULL DEFAULT '{}',
  -- 挂起期间 task 所处的状态（waiting_approval / waiting_input），便于恢复时校验。
  task_state       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  resolved_at      TEXT,
  -- 恢复结果：resumed（同 task 续跑）/ cancelled（挂起终止，如审批拒绝派返工）。
  resolution       TEXT CHECK (resolution IS NULL OR resolution IN ('resumed', 'cancelled'))
);

-- 按 task 查挂起历史。
CREATE INDEX idx_task_suspension_task ON task_suspension(task_id, created_at);
-- 按"未恢复"筛选，供看板"当前被阻塞的 task"查询用。
CREATE INDEX idx_task_suspension_unresolved ON task_suspension(task_id) WHERE resolved_at IS NULL;
