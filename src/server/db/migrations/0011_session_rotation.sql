-- 会话轮换（PRD Phase 3.6）：按时间强制新 session，独立于按次数的压缩。
-- last_rotation_at 记录上次开新 session 的时间；超过 MUSTER_SESSION_ROTATION_HOURS 即轮换。
ALTER TABLE project_agent_thread ADD COLUMN last_rotation_at TEXT;
