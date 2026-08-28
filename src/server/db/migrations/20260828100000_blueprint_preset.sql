-- 预制蓝图（2026-08-28 定案）：蓝图库冷启动为空、唯一来源是自动复盘进化，
-- 新工作台的任务穿不上任何专家。补预制蓝图 8 套开箱即用（blueprint-presets.ts）。
-- source：evolved=自动复盘进化（默认，存量行即此）；preset=预制播种。
-- preset_snapshot_json：预制蓝图的原版完整定义（staffing/description/stages/taskType/label）——
-- 进化/优化发生在行本身（工作态），原版永远存于快照；蓝图库页可单独重置（恢复原版+清战绩）。
ALTER TABLE blueprint ADD COLUMN source TEXT NOT NULL DEFAULT 'evolved';
ALTER TABLE blueprint ADD COLUMN preset_snapshot_json TEXT;
