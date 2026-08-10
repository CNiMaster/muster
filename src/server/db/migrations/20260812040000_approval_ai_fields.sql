-- AI 审批增强：四级递进判定 + 学习记忆支持
-- permission_approval 加 AI 判定字段，供批量审批 UI 展示与分类
ALTER TABLE permission_approval ADD COLUMN ai_verdict TEXT;
ALTER TABLE permission_approval ADD COLUMN ai_suggestion TEXT;
ALTER TABLE permission_approval ADD COLUMN ai_reason TEXT;
ALTER TABLE permission_approval ADD COLUMN ai_confidence TEXT;
ALTER TABLE permission_approval ADD COLUMN safety_category TEXT;
-- AI 判定的最高安全级别：execute_once/project_scope/company_scope/permanent
-- 系统按此级别自动建规则（仅 project_scope 及以下自动；company/permanent 需人工批量升级）
ALTER TABLE permission_approval ADD COLUMN highest_safe_level TEXT;
