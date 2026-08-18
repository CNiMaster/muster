-- 项目/任务管理工作台批1：项目任务置顶位（project_task 无 settings 袋，加列）。
-- 项目侧的分组(group)/排序(sortOrder)/移除隐藏(removed)走 project.settings_json 自由袋，零列变更
-- （先例：收件箱 inbox 标记）。置顶影响列表排序，需要服务端可查，故落列。
ALTER TABLE project_task ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
