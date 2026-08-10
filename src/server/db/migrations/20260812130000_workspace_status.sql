-- Review 修复（M-6）：workspace 增加迁移标记列——迁移先置 migrating 再移文件，中断后启动时可自愈。
ALTER TABLE workspace ADD COLUMN status TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal','migrating'));
ALTER TABLE workspace ADD COLUMN migrate_target_dir TEXT;
