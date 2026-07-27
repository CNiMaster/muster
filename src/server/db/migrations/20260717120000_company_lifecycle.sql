-- 公司生命周期：归档（暂停营业可重开）+ 审批模式
-- 归档用 archived_at 表达（非空 = 已归档），不进 state 列，避免破坏现有 CHECK 约束。
-- 归档公司允许同名，所以不加 UNIQUE(name)；查重在应用层（active 公司内不重名）。
ALTER TABLE company ADD COLUMN archived_at TEXT;
ALTER TABLE company ADD COLUMN archived_reason TEXT;

-- 业务产物审批模式：blocking=提交后阻塞等待；parallel=提交后继续下一个 Task。
ALTER TABLE company ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'blocking';
