-- 批次 H.5：会话排队条（服务端持久化——刷新/换设备不丢；drain 由 coordinator tick 驱动）。
-- 语义：当前任务运行中用户继续输入 → 入队（排队模式）；当前轮结束自动按序送出；
-- ↑立即 = 打断插话（interruptTask：置 queued + abort）后立即送出。
CREATE TABLE queued_message (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  -- 绑定项目任务（发送时带 projectTaskId 上下文）；NULL=项目级群聊
  project_task_id  TEXT REFERENCES project_task(id) ON DELETE SET NULL,
  content          TEXT NOT NULL,
  options_json     TEXT NOT NULL DEFAULT '{}',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  -- 手动排序位（拖动调序重写全列；同项目内升序送出）
  position         INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'cancelled')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX idx_queued_message_pending ON queued_message(project_id, position) WHERE status = 'pending';
