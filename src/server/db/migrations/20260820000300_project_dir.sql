-- 2026-08-20 workspace 治理批次3：项目多目录绑定。
-- 用户可把现有文件夹（代码仓库/素材库等）绑定到项目；一个项目可绑多个。
-- 只记 attached/external 两类（系统主目录仍走 project.root_dir，避免双写漂移）：
-- - external：创建项目时用户指定的目录（主目录）
-- - attached：后续绑定的附加工作目录
-- is_anchor：任务 worktree 锚点（仅 git 仓库可设；默认主目录）。
-- 解绑=只删行不动盘（铁律）；绑定路径不得与其他项目的目录交叉（防跨项目误写）。
CREATE TABLE project_dir (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('external','attached')),
  label TEXT,
  is_anchor INTEGER NOT NULL DEFAULT 0 CHECK (is_anchor IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, path)
);
CREATE INDEX idx_project_dir_project ON project_dir(project_id);
CREATE UNIQUE INDEX idx_project_dir_single_anchor ON project_dir(project_id) WHERE is_anchor=1;
