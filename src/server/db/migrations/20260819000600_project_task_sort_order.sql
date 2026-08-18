-- 项目/任务管理工作台（修订轮）：任务拖动排序持久化。
-- sort_order 默认 0（未手动排过），拖动后自上而下赋 1..N；列表序 = pinned DESC, sort_order ASC, seq DESC
-- ——未拖动过的列表保持原「最新在前」语义（0 在前=新任务靠顶），拖动过的按用户手排。
ALTER TABLE project_task ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
