-- 2026-08-23 用户定案：全局上下班概念退役——默认常上班；off 语义保留（draining/review_paused 局部挂起链路仍可用）。
-- 存量库中因旧默认值停在 off 的工作台统一转为 online。
UPDATE workbench SET state='online' WHERE state='off';
