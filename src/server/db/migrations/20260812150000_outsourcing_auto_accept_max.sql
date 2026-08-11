-- spec 2026-08-12-subagent-observability B3：外包自动接受退避封顶。
-- auto_accept_max_attempts：自动接受连续失败上限（默认 8）。达到上限后契约转入 auto_accept_disabled
-- 终态，停止反复 accept→失败→revert 空转，避免持续做无用功（需人工介入修复乙方配置）。
ALTER TABLE outsourcing_contract ADD COLUMN auto_accept_max_attempts INTEGER NOT NULL DEFAULT 8;
