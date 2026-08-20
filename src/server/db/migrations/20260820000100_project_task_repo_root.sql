-- 2026-08-20 workspace 治理批次1：独立任务按载体分仓。
-- 独立任务（隐藏 standalone 项目）的每个 project_task 拥有自己的仓库目录
-- tasks/YYYY-MM/MMDD-HHmm-<截断名>/，首次需要 worktree 时懒创建并记录在此列；
-- 业务项目任务不使用该列（沿用 project.rootDir）。
ALTER TABLE project_task ADD COLUMN repo_root_dir TEXT;
