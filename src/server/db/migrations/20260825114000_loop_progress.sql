-- R3 半途进度不白费（合并计划 2026-08-25-network-retry-progress-recovery-plan.md）：
-- API 型 runToolLoop 每轮完成的轮次快照（checkpoint）。任务终态成功清除；失败保留供断点续跑。
-- messages_json 为压缩控体积后的 ChatMessage[]（经 compactMessagesToDigest）；input_hash=任务输入包哈希，
-- 续跑时匹配才复用（输入已变→弃快照从头）。CLI 型不写入（vendor session 保真已覆盖）。
CREATE TABLE loop_progress (
  task_id TEXT PRIMARY KEY,
  run_id TEXT,
  rounds INTEGER NOT NULL DEFAULT 0,
  messages_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
