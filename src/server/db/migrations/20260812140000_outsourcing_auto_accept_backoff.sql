-- Review 修复（M-1 退避）：外包契约自动接受失败退避——避免每 tick（2s）反复 accept→失败→revert 空转。
-- auto_accept_attempt_count：自动路径连续失败次数（成功后清零）。
-- auto_accept_after_at：下次允许自动接受的时间；未设置则无限制。
ALTER TABLE outsourcing_contract ADD COLUMN auto_accept_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outsourcing_contract ADD COLUMN auto_accept_after_at TEXT;
