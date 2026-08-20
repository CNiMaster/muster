-- 2026-08-20 workspace 治理批次2：软件回收站（两段式删除第一段）。
-- 项目移入 .trash/ 时记账：原路径/回收路径/大小/暂停的自动化/批次号/时间。
-- 真删（第二段）＝移入系统废纸篓 + 删库（FK 级联清 tasks 等，同 removeProject deleteRecords）。
-- 铁律不变：软件永不 rm 用户数据；ghost 项目（目录从未落盘）trash_dir 为空串，恢复/真删只动库。
CREATE TABLE project_trash (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  original_root_dir TEXT NOT NULL,
  trash_dir TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  paused_automation_ids_json TEXT NOT NULL DEFAULT '[]',
  batch_id TEXT,
  trashed_at TEXT NOT NULL
);
