-- 蓝图工作流化批次B M2（2026-08-29）：阶段级记账表 + task_stage_run 冻结快照补列（additive）。
-- blueprint_stage_stat：哪一步常返工/常被门拦——AI 优化对话的内部数据依据（被动观测，不做用户看板）。
-- task_stage_run.gate/tools_json：阶段门与阶段工具亲和随领取时的蓝图快照冻结（跑动中蓝图变更不影响本任务）。
CREATE TABLE blueprint_stage_stat (
  id TEXT PRIMARY KEY,
  blueprint_id TEXT NOT NULL REFERENCES blueprint(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  label TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  reworks INTEGER NOT NULL DEFAULT 0,
  gate_fails INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(blueprint_id, stage_id)
);
CREATE INDEX idx_bss_blueprint ON blueprint_stage_stat(blueprint_id, reworks DESC);
ALTER TABLE task_stage_run ADD COLUMN gate TEXT;
ALTER TABLE task_stage_run ADD COLUMN tools_json TEXT;
