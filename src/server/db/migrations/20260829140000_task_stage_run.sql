-- 蓝图工作流化批次④ M1（2026-08-29）：任务阶段执行表——蓝图 stages 从图纸变调度。
-- 每行=任务的一个阶段执行实例：领取时从蓝图 stages 冻结快照建行（label/depends_on/staffing 冗余存行内，
-- 跑动中蓝图被改/回滚不影响本任务，Temporal 事件溯源精神）；引擎在完成漏斗拦截推进：
-- 当前阶段 passed（summary/artifacts 落行）→ 下一阶段 running → 任务经专用迁移 running→queued 回队列
-- 并按 staffingPersonaIds[0] 改派执行者；末阶段完成才走原 completeTask 收口。
-- 失败/等待/审批暂停不动游标——恢复后重跑当前阶段（n8n 式 retry-from-failed-step）。
CREATE TABLE task_stage_run (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  blueprint_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  depends_on_json TEXT,
  staffing_persona_ids_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','passed','failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  assignee_agent_id TEXT,
  summary TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, stage_id)
);
CREATE INDEX idx_tsr_task ON task_stage_run(task_id, step);
CREATE INDEX idx_tsr_blueprint ON task_stage_run(blueprint_id);
